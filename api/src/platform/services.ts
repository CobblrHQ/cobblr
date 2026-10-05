// platform().services: the one door to outside work (services.md §10).
//
// A call of a capability is always a job, a row in the workspace's own
// core_services_jobs (the core-services module owns the schema). invoke routes
// it (who answers, in order), gates it (who has to say yes), makes it
// idempotent (the same call twice is one job) and hands it to the poller.
// The poller is one queue worker, `services.poll`, per job: it uploads the
// inputs, submits, polls with backoff, validates the answer against the
// capability's output schema, copies output files into core-files and emits
// the job's events. Its state is the row, so a restart resumes it.
//
// What this file does NOT own:
//   - service connections, their routes and rank, and the signed hop: the
//     Connections half (a ServiceConnectionPort registered at boot);
//   - the consent rule and the hop limit: the service gate
//     (service-gate.ts), which decides whether a job runs, waits for a
//     confirm, or is refused, and how far along its chain it is.
//
// No secret is written here: a connection's key never reaches a row, an event
// or a log line. Errors from a hop keep the status and the service's error
// code, never a header or a body.

import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { gateServiceJob } from "./service-gate.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  platform,
  type PlatformServices,
} from "@cobblr/platform-contract";
import {
  SERVICE_DEADLINE_FLOOR_MS,
  SERVICE_MAX_HANDOFFS,
  SERVICE_POLL_MAX_S,
  ServicesNotReadyError,
  TERMINAL_JOB_STATUSES,
  isServiceCapabilityId,
  strongerEffect,
  adapterGroupOf,
  type AdapterFetch,
  type AdapterMetadata,
  type BuiltInServiceDef,
  type BuiltInServiceContext,
  type RemoteServiceJob,
  serviceFilesProblems,
  type ServiceCapabilityDecl,
  type ServiceCapabilityView,
  type ServiceChainStep,
  type ServiceConnectionHolder,
  type ServiceDoor,
  type ServiceEffect,
  type ServiceError,
  type ServiceInvokeRequest,
  type ServiceJob,
  type ServiceJobRef,
  type ServiceJobStatus,
  type ServiceManifest,
  type ServiceSubmitAnswer,
  type ServiceSubmitBody,
} from "@cobblr/platform-contract/services";
import { getTenantDb } from "../db/tenant.js";
import { validateAgainst } from "./service-schema.js";

// ── Storage ─────────────────────────────────────────────────────────────

export interface JobsTable {
  id: string;
  capability: string;
  capability_version: number;
  connection_id: string | null;
  built_in: string | null;
  pinned: boolean;
  remote_job_id: string | null;
  status: ServiceJobStatus;
  progress: number | null;
  message: string | null;
  needs: unknown;
  input: unknown;
  output: unknown;
  error: unknown;
  origin: ServiceDoor;
  requested_by: string | null;
  confirmed_by: string | null;
  confirm_hash: string | null;
  caused_by_job: string | null;
  hop: number;
  attach_to: unknown;
  idempotency_key: string;
  service_version: string | null;
  manifest_version: string | null;
  poll_errors: number;
  /** The live attempt: raised when the job is handed on. Every poller write
   *  is bound to it, so a replaced attempt's late answer changes nothing. */
  attempt: number;
  retry_of: string | null;
  skipped_by: string | null;
  skipped_at: Date | null;
  last_progress_at: Date | null;
  stalled_at: Date | null;
  deadline_at: Date | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}
interface JobFilesTable {
  job_id: string;
  name: string;
  direction: "in" | "out";
  file_id: string;
  sha256: string | null;
}
interface ServicesDB {
  core_services_jobs: JobsTable;
  core_services_job_files: JobFilesTable;
}
const tdb = async (orgId: string) => (await getTenantDb(orgId)) as unknown as Kysely<ServicesDB>;

// ── The Connections half, registered at boot ────────────────────────────

/** A connected service as the kernel needs it. The key is the transport's
 *  business, never the kernel's. */
export interface ServiceConnectionRef {
  credentialId: string;
  label: string;
  scope: ServiceChainStep["scope"];
  manifest: ServiceManifest;
  manifestVersion: string;
  /** An adapter's connection: the built-in that runs it (the manifest is
   *  synthesised from that built-in). Its jobs run in process with the
   *  connection's settings, never over a hop. */
  adapter?: string;
}

export interface ServiceHopResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ServiceConnectionPort {
  /** The connections that serve a capability for this person here, in order.
   *  `via` pins one: no fall-through. */
  chainFor(orgId: string, userId: string | null, capability: string, opts?: { via?: string }): Promise<ServiceConnectionRef[]>;
  byId(credentialId: string): Promise<ServiceConnectionRef | null>;
  /** Every connection this person can call here, for the capability list. */
  list(orgId: string, userId: string | null): Promise<ServiceConnectionRef[]>;
  /** An adapter connection's settings, decrypted; null when the row is gone
   *  or is not an adapter's. Read only to run a job, so a ref stays free of
   *  secrets. */
  configFor?(credentialId: string): Promise<Record<string, string> | null>;
  /** Persist only this adapter group's declared secrets, with stale-write protection. */
  updateSecrets?(credentialId: string, group: string, expected: Readonly<Record<string, string>>, patch: Readonly<Record<string, string>>): Promise<void>;
  /** One signed hop, direct or through the owner's bridge. `path` is under
   *  the manifest's api.base_path. */
  fetch(credentialId: string, req: { method: string; path: string; body?: Uint8Array | string; headers?: Record<string, string> }): Promise<ServiceHopResponse>;
  /** An adapter connection's way to its program (its base_url, direct or
   *  through its owner's bridge), handed to the built-in as `ctx.fetch`.
   *  Null when the row is gone or is not an adapter's. */
  adapterFetch?(credentialId: string): Promise<AdapterFetch | null>;
  /** Every connection that answers a capability in this workspace, with its
   *  owner and whether it is shared (PlatformServices.connectionsFor). */
  holders?(orgId: string, capability: string): Promise<ServiceConnectionHolder[]>;
}

let port: ServiceConnectionPort | null = null;
export function setServiceConnectionPort(p: ServiceConnectionPort | null): void {
  port = p;
}

// ── Consent, registered by S2 ───────────────────────────────────────────

export interface ServiceGateInput {
  orgId: string;
  door: ServiceDoor;
  userId: string | null;
  capability: string;
  effect: ServiceEffect;
  input: unknown;
  fileHashes: Record<string, string>;
  connectionId: string | null;
  causedByJob: string | null;
  /** The hop of the job that led here; null for a job nothing caused. */
  causeHop: number | null;
  /** The chat's write mode, for the cobb and mcp doors, when the door knows
   *  it. Absent: the gate reads the person's own. */
  writeMode?: "off" | "ask" | "auto";
  /** For the wire door: the wire's author let its writes run. */
  wireRuns?: boolean;
}
export interface ServiceGateVerdict {
  status: "queued" | "awaiting_confirm";
  confirm_hash: string | null;
  hop: number;
}
export type ServiceGate = (g: ServiceGateInput) => Promise<ServiceGateVerdict>;

const consentGate: ServiceGate = (g) =>
  gateServiceJob({
    orgId: g.orgId,
    door: g.door,
    capability: g.capability,
    effect: g.effect,
    input: g.input,
    fileHashes: g.fileHashes,
    connectionId: g.connectionId,
    causeHop: g.causeHop,
    ...(g.writeMode ? { writeMode: g.writeMode } : {}),
    ...(g.wireRuns !== undefined ? { wireRuns: g.wireRuns } : {}),
  });

let gate: ServiceGate = consentGate;
export function setServiceGate(g: ServiceGate): void {
  gate = g;
}

/** A person's yes to an awaiting_confirm job, with the consent rule (S2,
 *  service-confirm.ts). Registered at boot beside the gate. */
type ServiceConfirm = (orgId: string, jobId: string, userId: string) => Promise<void>;
let confirmImpl: ServiceConfirm = async () => {
  throw new ServicesNotReadyError("confirming a job");
};
export function setServiceConfirm(c: ServiceConfirm): void {
  confirmImpl = c;
}

/** The supervisor's side of platform().services (service-supervisor.ts),
 *  registered at boot. */
export interface ServiceSupervisorHooks {
  run: PlatformServices["run"];
  raiseStuck: PlatformServices["raiseStuck"];
  settleStuck: PlatformServices["settleStuck"];
}
let supervisor: ServiceSupervisorHooks | null = null;
export function setServiceSupervisor(s: ServiceSupervisorHooks): void {
  supervisor = s;
}

// ── Built-ins ───────────────────────────────────────────────────────────

const builtIns = new Map<string, BuiltInServiceDef>();
const adapterMetadata = new Map<string, AdapterMetadata>();

/** Every registered built-in; the Connections page offers the ones with a
 *  `connection` (adapters) on Add a service. */
export function listBuiltIns(): BuiltInServiceDef[] {
  return [...builtIns.values()];
}

// ── Small pure helpers ──────────────────────────────────────────────────

export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Refused before a job exists: the caller hears why, nothing is stored. */
export class ServiceRefusal extends Error {
  constructor(
    public readonly code: "unknown_capability" | "no_service" | "invalid_input" | "missing_file" | "hop_limit" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "ServiceRefusal";
  }
}

// ── Routing ─────────────────────────────────────────────────────────────

interface Route {
  step: ServiceChainStep;
  decl: ServiceCapabilityDecl;
  manifest: ServiceManifest | null;
  connection: ServiceConnectionRef | null;
  builtIn: BuiltInServiceDef | null;
}

async function routesFor(orgId: string, userId: string | null, capability: string, via?: ServiceInvokeRequest["via"]): Promise<Route[]> {
  const out: Route[] = [];
  const pinnedConn = via && "credentialId" in via ? via.credentialId : undefined;
  const pinnedBuiltIn = via && "builtIn" in via ? via.builtIn : undefined;
  if (!pinnedBuiltIn) {
    const conns = port ? await port.chainFor(orgId, userId, capability, pinnedConn ? { via: pinnedConn } : undefined) : [];
    for (const c of conns) {
      if (c.adapter) {
        // An adapter's connection: the built-in of its group that does this
        // capability answers, with its own declaration, on the settings of
        // this connection.
        const def = [...builtIns.values()].find((b) => b.connection && adapterGroupOf(b) === c.adapter && b.capability.id === capability);
        if (def) {
          out.push({ step: { source: "connection", credential_id: c.credentialId, label: c.label || def.name, scope: c.scope }, decl: def.capability, manifest: null, connection: c, builtIn: def });
        }
        continue;
      }
      const decl = c.manifest.capabilities.find((x) => x.id === capability);
      if (decl) out.push({ step: { source: "connection", credential_id: c.credentialId, label: `${c.manifest.name} ${c.manifest.version}`, scope: c.scope }, decl, manifest: c.manifest, connection: c, builtIn: null });
    }
  }
  if (!pinnedConn) {
    for (const b of builtIns.values()) {
      if (b.connection) continue; // an adapter answers only on a connection made for it
      if (b.capability.id === capability && (!pinnedBuiltIn || b.id === pinnedBuiltIn)) out.push({ step: { source: "built-in", built_in: b.id, label: b.name, scope: "platform" }, decl: b.capability, manifest: null, connection: null, builtIn: b });
    }
  }
  return out;
}

// ── Reading a job ───────────────────────────────────────────────────────

function toJob(r: JobsTable, files: JobFilesTable[]): ServiceJob {
  return {
    id: r.id,
    capability: r.capability,
    connection_id: r.connection_id,
    built_in: r.built_in,
    status: r.status,
    progress: r.progress,
    message: r.message,
    needs: (r.needs as ServiceJob["needs"]) ?? null,
    input: r.input,
    output: r.output ?? null,
    files: files.map((f) => ({ file_id: f.file_id, name: f.name, direction: f.direction })),
    error: (r.error as ServiceError | null) ?? null,
    origin: r.origin,
    requested_by: r.requested_by,
    confirmed_by: r.confirmed_by,
    caused_by_job: r.caused_by_job,
    hop: r.hop,
    attach_to: (r.attach_to as ServiceJob["attach_to"]) ?? null,
    service_version: r.service_version,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

// ── Readings: answered without a row ────────────────────────────────────

const EPHEMERAL_PREFIX = "reading:";
const EPHEMERAL_KEEP_MS = 10 * 60_000;
const EPHEMERAL_MAX = 1000;
const readings = new Map<string, { orgId: string; at: number; job: ServiceJob }>();

export interface ReadingStat {
  capability: string;
  count: number;
  failed: number;
  last_at: string;
  last_status: ServiceJobStatus;
}
const readingStats = new Map<string, ReadingStat>();

/** How often each capability was read without a row, and how the last one
 *  went, per workspace: what a supervisor or diagnostics page shows for
 *  readings. In memory; a restart starts the counts again. */
export function readingStatsFor(orgId: string): ReadingStat[] {
  return [...readingStats.entries()].filter(([k]) => k.startsWith(`${orgId}|`)).map(([, v]) => v);
}

async function runEphemeral(orgId: string, def: BuiltInServiceDef, input: unknown, connectionId: string | null, door: { origin: ServiceDoor; userId: string | null }): Promise<ServiceJobRef> {
  const id = `${EPHEMERAL_PREFIX}${crypto.randomUUID()}`;
  const started = new Date().toISOString();
  let status: ServiceJobStatus = "done";
  let output: unknown = null;
  let error: ServiceError | null = null;
  try {
    // An adapter reads on the settings of the connection it was routed to,
    // exactly as its job would; a reading is no reason to run without them.
    const adapter = def.connection ? await adapterContext(def, connectionId) : {};
    if (adapter === null) throw new Error(`the ${def.connection!.title} connection this was sent to is no longer here`);
    const result = await def.run({ orgId, jobId: id, input, files: {}, progress: async () => {}, ...adapter });
    const check = validateAgainst(def.capability.output_schema, undefined, result.output);
    if (!check.ok) {
      status = "failed";
      error = failure("internal", `${def.name} answered outside its own schema: ${check.errors.join("; ")}`);
    } else output = result.output ?? null;
  } catch (err) {
    status = "failed";
    error = failure("internal", (err as Error).message.slice(0, 300));
  }
  const now = new Date().toISOString();
  const job: ServiceJob = {
    id, capability: def.capability.id, connection_id: connectionId, built_in: def.id, status, progress: 1, message: null, needs: null,
    input, output, files: [], error, origin: door.origin, requested_by: door.userId, confirmed_by: null, caused_by_job: null, hop: 0,
    attach_to: null, service_version: null, created_at: started, updated_at: now,
  };
  readings.set(id, { orgId, at: Date.now(), job });
  if (readings.size > EPHEMERAL_MAX) {
    const cutoff = Date.now() - EPHEMERAL_KEEP_MS;
    for (const [k, v] of readings) if (v.at < cutoff || readings.size > EPHEMERAL_MAX) readings.delete(k);
  }
  const key = `${orgId}|${def.capability.id}`;
  const stat = readingStats.get(key) ?? { capability: def.capability.id, count: 0, failed: 0, last_at: now, last_status: status };
  readingStats.set(key, { ...stat, count: stat.count + 1, failed: stat.failed + (status === "failed" ? 1 : 0), last_at: now, last_status: status });
  return { id, status };
}

async function readJob(orgId: string, jobId: string): Promise<ServiceJob | null> {
  if (jobId.startsWith(EPHEMERAL_PREFIX)) {
    const r = readings.get(jobId);
    return r && r.orgId === orgId ? r.job : null;
  }
  const db = await tdb(orgId);
  const row = await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!row) return null;
  const files = await db.selectFrom("core_services_job_files").selectAll().where("job_id", "=", jobId).execute();
  return toJob(row as JobsTable, files as JobFilesTable[]);
}

export async function emit(orgId: string, job: { id: string; capability: string; status: ServiceJobStatus; caused_by_job: string | null; hop: number; attach_to?: unknown; output?: unknown }): Promise<void> {
  // The record the job was for, when it was for one: a wire on these events
  // that acts on that record reads it here (a job is not a record itself).
  const attachTo = attachToOf(job.attach_to);
  const payload = { orgId, jobId: job.id, capability: job.capability, status: job.status, causedByJob: job.caused_by_job, hop: job.hop, ...(attachTo ? { attachTo } : {}),
    // What a finished job answered, schema-checked already: the next step's
    // input reads it as {{event.output.<field>}}.
    ...(job.status === "done" && job.output != null ? { output: job.output } : {}) };
  try {
    await platform().events.emit("services.job.updated", payload);
    if (job.status === "done") await platform().events.emit("services.job.done", payload);
    else if (job.status === "failed") await platform().events.emit("services.job.failed", payload);
    else if (job.status === "needs_input") await platform().events.emit("services.job.needs_input", payload);
  } catch (err) {
    console.warn(`[services] job ${job.id}: event not emitted: ${(err as Error).message}`);
  }
}

function attachToOf(raw: unknown): { kind: string; id: string } | null {
  const v = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
  if (!v || typeof v !== "object") return null;
  const { kind, id } = v as { kind?: unknown; id?: unknown };
  return typeof kind === "string" && typeof id === "string" ? { kind, id } : null;
}

// ── invoke ──────────────────────────────────────────────────────────────

/** The internal door. Each door stamps who is asking; module code reaches
 *  only `invoke`, which is always the module door with no person. */
export async function invokeAs(
  door: { origin: ServiceDoor; userId: string | null; writeMode?: "off" | "ask" | "auto"; wireRuns?: boolean },
  req: ServiceInvokeRequest,
): Promise<ServiceJobRef> {
  const { orgId, capability } = req;
  if (!isServiceCapabilityId(capability)) throw new ServiceRefusal("unknown_capability", `"${capability}" is not a service capability`);

  // The loop guard counts along the chain of jobs that led here; the gate
  // decides where that chain stops.
  const db = await tdb(orgId);
  let causeHop: number | null = null;
  if (req.causedByJob) {
    const cause = await db.selectFrom("core_services_jobs").select(["hop"]).where("id", "=", req.causedByJob).executeTakeFirst();
    causeHop = cause?.hop ?? 0;
  }

  const routes = await routesFor(orgId, door.userId, capability, req.via);
  const route = routes[0];
  if (!route) {
    throw new ServiceRefusal("no_service", req.via ? "the one named does not offer this, or is not yours to use here" : `nothing connected here does ${capability}`);
  }

  const inputCheck = validateAgainst(route.decl.input_schema, route.manifest?.$defs, req.input);
  if (!inputCheck.ok) throw new ServiceRefusal("invalid_input", `the input does not fit ${capability}: ${inputCheck.errors.join("; ")}`);

  // Inputs: every required file named, each by content.
  const files = req.files ?? {};
  const fileProblems = serviceFilesProblems(capability, route.decl.files_in ?? [], files);
  if (fileProblems.length) throw new ServiceRefusal(fileProblems.some((p) => p.includes(" needs a ")) ? "missing_file" : "invalid_input", fileProblems.join("; "));
  const fileHashes: Record<string, string> = {};
  for (const [name, fileId] of Object.entries(files)) {
    const bytes = await platform().files.read(orgId, fileId);
    if (!bytes) throw new ServiceRefusal("missing_file", `the file for "${name}" is not in this workspace`);
    fileHashes[name] = sha256(bytes.bytes);
  }

  // Every call passes the gate first, a reading too: a workspace that turned
  // a capability off has turned it off for module code as well.
  const verdict = await gate({
    orgId,
    door: door.origin,
    userId: door.userId,
    capability,
    effect: route.decl.effect,
    input: req.input ?? null,
    fileHashes,
    connectionId: route.connection?.credentialId ?? null,
    causedByJob: req.causedByJob ?? null,
    causeHop,
    ...(door.writeMode ? { writeMode: door.writeMode } : {}),
    ...(door.wireRuns !== undefined ? { wireRuns: door.wireRuns } : {}),
  });

  // A reading: module code asking a built-in something that changes nothing,
  // answered on the spot, with nothing to keep (a print watch asking about
  // every frame). No row: the answer comes back inline and a counter keeps
  // the last one for the supervisor. Anything with files, a person, a record
  // to attach to or a job that led here keeps its row.
  if (
    (door.origin === "module" || route.decl.effect === "signal") &&
    route.builtIn &&
    route.decl.mode === "sync" &&
    (route.decl.effect === "none" || route.decl.effect === "signal") &&
    !(route.decl.files_out ?? []).length &&
    !Object.keys(files).length &&
    !req.attachTo &&
    !req.causedByJob &&
    verdict.status === "queued"
  ) {
    return runEphemeral(orgId, route.builtIn, req.input ?? null, route.connection?.credentialId ?? null, door);
  }

  const target = route.connection ? `c:${route.connection.credentialId}` : `b:${route.builtIn!.id}`;
  const idempotencyKey = sha256(stableJson([target, capability, req.input ?? null, fileHashes, req.idempotencyKey ?? null]));
  const existing = await db.selectFrom("core_services_jobs").select(["id", "status"]).where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
  if (existing) return { id: existing.id, status: existing.status };

  const inserted = await db
    .insertInto("core_services_jobs")
    .values({
      capability,
      capability_version: route.decl.version,
      connection_id: route.connection?.credentialId ?? null,
      built_in: route.builtIn?.id ?? null,
      pinned: !!req.via,
      status: verdict.status,
      input: sql`${JSON.stringify(req.input ?? null)}::jsonb` as never,
      origin: door.origin,
      requested_by: door.userId,
      confirm_hash: verdict.confirm_hash,
      caused_by_job: req.causedByJob ?? null,
      hop: verdict.hop,
      attach_to: req.attachTo ? (sql`${JSON.stringify(req.attachTo)}::jsonb` as never) : null,
      idempotency_key: idempotencyKey,
      last_progress_at: new Date(),
      manifest_version: route.connection && !route.connection.adapter ? route.connection.manifestVersion : null,
    } as never)
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning(["id", "status"])
    .executeTakeFirst();
  if (!inserted) {
    // Two identical calls at once: the other one won.
    const won = await db.selectFrom("core_services_jobs").select(["id", "status"]).where("idempotency_key", "=", idempotencyKey).executeTakeFirstOrThrow();
    return { id: won.id, status: won.status };
  }
  const fileRows = Object.entries(files).map(([name, fileId]) => ({ job_id: inserted.id, name, direction: "in" as const, file_id: fileId, sha256: fileHashes[name] ?? null }));
  if (fileRows.length) await db.insertInto("core_services_job_files").values(fileRows).execute();

  await emit(orgId, { id: inserted.id, capability, status: verdict.status, caused_by_job: req.causedByJob ?? null, hop: verdict.hop });
  if (verdict.status !== "queued") return { id: inserted.id, status: verdict.status };
  // A sync capability answers inside the call: its steps run here, without
  // the queue's round trip, and the caller reads the answer at once. One that
  // takes longer than a request should falls back to the poller.
  if (route.decl.mode === "sync") {
    const settled = await runInline(orgId, inserted.id);
    if (settled) return settled;
  }
  await startQueuedJob(orgId, inserted.id);
  return { id: inserted.id, status: verdict.status };
}

const INLINE_BUDGET_MS = 20_000;

/** Run a job's steps now, for a sync capability. The job's ref once it is
 *  terminal, or null when it needs longer (the caller queues it). */
async function runInline(orgId: string, jobId: string): Promise<ServiceJobRef | null> {
  const until = Date.now() + INLINE_BUDGET_MS;
  for (let attempt = 0; Date.now() < until; attempt++) {
    const next = await step(orgId, jobId, attempt);
    const db = await tdb(orgId);
    const row = await db.selectFrom("core_services_jobs").select(["id", "status"]).where("id", "=", jobId).executeTakeFirst();
    if (!row) return null;
    if (TERMINAL_JOB_STATUSES.has(row.status) || row.status === "needs_input") return { id: row.id, status: row.status };
    if (next == null) return null;
    await new Promise((r) => setTimeout(r, Math.min(next * 1000, 500, Math.max(0, until - Date.now()))));
  }
  return null;
}

/** Hand a queued job to the poller. Idempotent: one poll chain per job. The
 *  confirm (S2) calls this after it moves a job out of awaiting_confirm. */
export async function startQueuedJob(orgId: string, jobId: string, runAt?: Date): Promise<void> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row) return;
  // The clock starts when the work does: time spent waiting for a person's
  // yes or answer never counts against a service.
  const budget = await deadlineBudgetMs(row);
  await db
    .updateTable("core_services_jobs")
    .set({ deadline_at: budget == null ? null : new Date(Date.now() + budget), stalled_at: null, last_progress_at: new Date() } as never)
    .where("id", "=", jobId)
    .where("attempt", "=", row.attempt)
    .execute();
  await platform().queue.enqueue({ orgId, queue: POLL_QUEUE, payload: { jobId, gen: row.attempt }, idempotencyKey: `services.job:${jobId}:g${row.attempt}`, maxAttempts: 5, ...(runAt ? { runAt } : {}) });
}

/** The declaration of whoever answers this job now. */
async function declOf(row: Pick<JobsTable, "built_in" | "connection_id" | "capability">): Promise<{ decl: ServiceCapabilityDecl | Omit<ServiceCapabilityDecl, "options_endpoint">; label: string } | null> {
  if (row.built_in) {
    const b = builtIns.get(row.built_in);
    return b ? { decl: b.capability, label: b.name } : null;
  }
  const conn = row.connection_id && port ? await port.byId(row.connection_id) : null;
  const decl = conn?.manifest.capabilities.find((c) => c.id === row.capability);
  return conn && decl ? { decl, label: conn.label || conn.manifest.name } : null;
}

/** How long a job may run: 3x what its capability says it typically takes,
 *  never under the floor. Null when the capability does not say; then only
 *  the no-change rule applies. */
async function deadlineBudgetMs(row: JobsTable): Promise<number | null> {
  const t = (await declOf(row))?.decl.typical_seconds;
  return typeof t === "number" && t > 0 ? Math.max(SERVICE_DEADLINE_FLOOR_MS, 3 * t * 1000) : null;
}

// ── The poller ──────────────────────────────────────────────────────────

const POLL_QUEUE = "services.poll";
/** How long a job that waits on a person is looked at again. */
const NEEDS_INPUT_POLL_S = 900;

/** Write to a job. `gen` binds the write to one attempt and `live` to a job
 *  that has not finished: a write from an attempt the supervisor replaced, or
 *  one landing after a cancel, matches no row and returns null. */
async function update(orgId: string, jobId: string, patch: Partial<Record<keyof JobsTable, unknown>>, guard?: { gen?: number; live?: boolean }): Promise<JobsTable | null> {
  const db = await tdb(orgId);
  const set: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    set[k] = v !== null && typeof v === "object" && !(v instanceof Date) ? sql`${JSON.stringify(v)}::jsonb` : v;
  }
  // The job moved: its status, progress or message is different from what
  // the row holds. A poll that learned nothing new leaves the clock alone, so
  // a supervisor can tell a stuck job from a slow one.
  const moved: ReturnType<typeof sql>[] = [];
  if ("status" in patch) moved.push(sql`status is distinct from ${patch.status as string}`);
  if ("progress" in patch) moved.push(sql`progress is distinct from ${(patch.progress as number | null) ?? null}::real`);
  if ("message" in patch) moved.push(sql`message is distinct from ${(patch.message as string | null) ?? null}`);
  if (moved.length) {
    const any = sql.join(moved, sql` or `);
    set.last_progress_at = sql`case when ${any} then now() else last_progress_at end`;
    // A job that moved is no longer stalled.
    if (!("stalled_at" in patch)) set.stalled_at = sql`case when ${any} then null else stalled_at end`;
  }
  let q = db.updateTable("core_services_jobs").set(set as never).where("id", "=", jobId);
  if (guard?.gen !== undefined) q = q.where("attempt", "=", guard.gen);
  if (guard?.live) q = q.where("status", "not in", ["done", "failed", "cancelled"]);
  return ((await q.returningAll().executeTakeFirst()) as JobsTable | undefined) ?? null;
}

async function finish(orgId: string, row: JobsTable, status: "done" | "failed" | "cancelled", patch: Partial<Record<keyof JobsTable, unknown>>): Promise<void> {
  const next = await update(orgId, row.id, { ...patch, status, finished_at: new Date() }, { gen: row.attempt, live: true });
  if (next) await emit(orgId, next);
}

const failure = (code: ServiceError["code"], message: string, retryable = false): ServiceError => ({ code, message, retryable });

function parseBody<T>(res: ServiceHopResponse): T | null {
  try {
    return JSON.parse(res.body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** A service's error as it said it, or one naming the status. Never the body
 *  verbatim: it could echo anything. */
function hopError(res: ServiceHopResponse): ServiceError {
  const e = parseBody<{ error?: Partial<ServiceError> }>(res)?.error;
  const code = typeof e?.code === "string" ? (e.code as ServiceError["code"]) : res.status >= 500 ? "internal" : "unsupported_input";
  const message = typeof e?.message === "string" ? e.message.slice(0, 300) : `the service answered ${res.status}`;
  return { code, message, retryable: typeof e?.retryable === "boolean" ? e.retryable : res.status === 503 || res.status >= 500 };
}

async function runBuiltIn(orgId: string, row: JobsTable): Promise<void> {
  const def = builtIns.get(row.built_in ?? "");
  if (!def) return finish(orgId, row, "failed", { error: failure("internal", "that built-in service is no longer here") });
  // An adapter runs on the settings of the connection the job was sent to.
  const adapter = def.connection ? await adapterContext(def, row.connection_id) : {};
  if (adapter === null) return finish(orgId, row, "failed", { error: failure("internal", `the ${def.connection!.title} connection this job was sent to is no longer here`) });
  const db = await tdb(orgId);
  const files = await db.selectFrom("core_services_job_files").select(["name", "file_id"]).where("job_id", "=", row.id).where("direction", "=", "in").execute();
  const running = await update(orgId, row.id, { status: "running" }, { gen: row.attempt, live: true });
  if (!running) return;
  await emit(orgId, running);
  try {
    const result = await def.run({
      orgId,
      jobId: row.id,
      input: row.input,
      files: Object.fromEntries(files.map((f) => [f.name, f.file_id])),
      ...adapter,
      progress: async (fraction, message) => {
        await update(orgId, row.id, { progress: Math.max(0, Math.min(1, fraction)), ...(message ? { message } : {}) }, { gen: row.attempt, live: true });
      },
    });
    const check = validateAgainst(def.capability.output_schema, undefined, result.output);
    if (!check.ok) return finish(orgId, running, "failed", { error: failure("internal", `${def.name} answered outside its own schema: ${check.errors.join("; ")}`) });
    await recordOutputs(orgId, running, Object.entries(result.files ?? {}).map(([name, fileId]) => ({ name, fileId })));
    await finish(orgId, running, "done", { output: result.output ?? null, progress: 1 });
  } catch (err) {
    await finish(orgId, running, "failed", { error: failure("internal", (err as Error).message.slice(0, 300)) });
  }
}

/** What an adapter runs with: its connection's settings and its one way to
 *  its program. Null when that connection is gone. */
async function adapterContext(def: BuiltInServiceDef, connectionId: string | null): Promise<Pick<BuiltInServiceContext, "config" | "connectionId" | "fetch" | "updateSecrets"> | null> {
  if (!def.connection || !connectionId || !port?.configFor) return null;
  const connectionPort = port;
  const config = await connectionPort.configFor!(connectionId);
  if (!config) return null;
  const fetch = connectionPort.adapterFetch ? await connectionPort.adapterFetch(connectionId) : null;
  let expected = { ...config };
  const updateSecrets = connectionPort.updateSecrets ? async (patch: Readonly<Record<string, string>>) => {
    const next = { ...patch };
    await connectionPort.updateSecrets!(connectionId, adapterGroupOf(def), expected, next);
    Object.assign(config, next);
    expected = { ...expected, ...next };
  } : undefined;
  return { config, connectionId, ...(fetch ? { fetch } : {}), ...(updateSecrets ? { updateSecrets } : {}) };
}

async function recordOutputs(orgId: string, row: JobsTable, outs: Array<{ name: string; fileId: string; sha256?: string }>): Promise<void> {
  if (!outs.length) return;
  const db = await tdb(orgId);
  await db
    .insertInto("core_services_job_files")
    .values(outs.map((o) => ({ job_id: row.id, name: o.name, direction: "out" as const, file_id: o.fileId, sha256: o.sha256 ?? null })))
    .onConflict((oc) => oc.columns(["job_id", "direction", "name"]).doNothing())
    .execute();
  const attachTo = row.attach_to as { kind?: string; id?: string } | null;
  for (const o of outs) {
    await platform().files.attach(orgId, { fileId: o.fileId, source_module: "platform", source_type: "service-job", source_id: row.id, role: o.name }).catch(() => null);
    if (attachTo?.kind && attachTo.id) {
      const [module, type] = attachTo.kind.split(":", 2);
      await platform().files.attach(orgId, { fileId: o.fileId, source_module: module!, source_type: type ?? "item", source_id: attachTo.id, role: o.name }).catch(() => null);
    }
  }
}

async function submitRemote(orgId: string, row: JobsTable, conn: ServiceConnectionRef): Promise<{ next: number } | null> {
  const db = await tdb(orgId);
  const files = await db.selectFrom("core_services_job_files").selectAll().where("job_id", "=", row.id).where("direction", "=", "in").execute();
  const wire: ServiceSubmitBody["files"] = {};
  for (const f of files) {
    const bytes = await platform().files.read(orgId, f.file_id);
    if (!bytes) {
      await finish(orgId, row, "failed", { error: failure("unsupported_input", `the input file "${f.name}" is gone from this workspace`) });
      return null;
    }
    const hash = f.sha256 ?? sha256(bytes.bytes);
    const head = await port!.fetch(conn.credentialId, { method: "HEAD", path: `/blobs/${hash}` });
    if (head.status !== 200) {
      const put = await port!.fetch(conn.credentialId, { method: "PUT", path: `/blobs/${hash}`, body: bytes.bytes, headers: { "content-type": "application/octet-stream" } });
      if (put.status !== 200 && put.status !== 201) {
        const e = hopError(put);
        if (e.retryable) throw new RetryableHop(e);
        await finish(orgId, row, "failed", { error: e });
        return null;
      }
    }
    wire[f.name] = { sha256: hash, name: bytes.filename, type: bytes.mimeType };
  }
  const body: ServiceSubmitBody = { capability: row.capability, capability_version: row.capability_version, idempotency_key: `cobblr:${row.idempotency_key}`, input: row.input, files: wire };
  const res = await port!.fetch(conn.credentialId, { method: "POST", path: "/jobs", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (res.status !== 202 && res.status !== 200) {
    const e = hopError(res);
    if (e.retryable) throw new RetryableHop(e);
    await finish(orgId, row, "failed", { error: e });
    return null;
  }
  const ans = parseBody<ServiceSubmitAnswer>(res);
  if (!ans?.job_id) {
    await finish(orgId, row, "failed", { error: failure("internal", "the service accepted the job but named no job id") });
    return null;
  }
  const next = await update(orgId, row.id, { remote_job_id: ans.job_id, status: ans.status === "queued" ? "queued" : "running", poll_errors: 0 }, { gen: row.attempt, live: true });
  if (!next) return null;
  await emit(orgId, next);
  const poll = { next: Math.max(1, Math.min(SERVICE_POLL_MAX_S, ans.poll_after_s ?? 2)) };
  // A sync capability answers with the finished job: take it from the answer
  // rather than asking again. If its files cannot be fetched yet, the poll
  // reads the same finished job; the job is the service's now and never goes
  // to the next in the order.
  if (TERMINAL_JOB_STATUSES.has(ans.status) || ans.status === "needs_input") {
    try {
      const after = await absorb(orgId, next, conn, ans as RemoteServiceJob, 0);
      return after === null ? null : { next: after };
    } catch (err) {
      if (err instanceof RetryableHop) return poll;
      throw err;
    }
  }
  return poll;
}

class RetryableHop extends Error {
  constructor(public readonly err: ServiceError) {
    super(err.message);
  }
}

/** One step of a job. Returns the seconds until the next, or null when the
 *  job needs nothing more from the poller. */
async function step(orgId: string, jobId: string, attempt: number, gen?: number): Promise<number | null> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row || TERMINAL_JOB_STATUSES.has(row.status) || row.status === "awaiting_confirm") return null;
  // A poll chain from an attempt the supervisor replaced ends here.
  if (gen !== undefined && row.attempt !== gen) return null;
  if (row.built_in) {
    await runBuiltIn(orgId, row);
    return null;
  }
  if (!port) throw new ServicesNotReadyError("reaching a service connection");
  const conn = row.connection_id ? await port.byId(row.connection_id) : null;
  if (!conn) {
    await finish(orgId, row, "failed", { error: failure("internal", "the service this job was sent to is no longer connected") });
    return null;
  }
  try {
    if (!row.remote_job_id) {
      const r = await submitRemote(orgId, row, conn);
      return r?.next ?? null;
    }
    const res = await port.fetch(conn.credentialId, { method: "GET", path: `/jobs/${encodeURIComponent(row.remote_job_id)}` });
    if (res.status !== 200) throw new RetryableHop(hopError(res));
    const job = parseBody<RemoteServiceJob>(res);
    if (!job) throw new RetryableHop(failure("internal", "the service's answer was not JSON", true));
    return await absorb(orgId, row, conn, job, attempt);
  } catch (err) {
    if (!(err instanceof RetryableHop)) throw err;
    // Before the service has the job, a busy or unreachable one hands it to
    // the next in the order (never for a pinned connection); after, keep
    // asking the same one, backing off.
    if (!row.remote_job_id && !row.pinned) {
      const routes = await routesFor(orgId, row.requested_by, row.capability);
      const at = routes.findIndex((r) => r.connection?.credentialId === row.connection_id);
      const nextRoute = routes[at + 1];
      if (nextRoute && row.poll_errors < 2) {
        await update(
          orgId,
          row.id,
          nextRoute.connection
            ? {
                connection_id: nextRoute.connection.credentialId,
                built_in: nextRoute.builtIn?.id ?? null,
                manifest_version: nextRoute.connection.adapter ? null : nextRoute.connection.manifestVersion,
                poll_errors: row.poll_errors + 1,
              }
            : { connection_id: null, built_in: nextRoute.builtIn!.id, poll_errors: row.poll_errors + 1 },
          { gen: row.attempt, live: true },
        );
        return 1;
      }
    }
    const errors = row.poll_errors + 1;
    if (errors >= 8) {
      await finish(orgId, row, "failed", { error: err.err, poll_errors: errors });
      return null;
    }
    if (!(await update(orgId, row.id, { poll_errors: errors }, { gen: row.attempt, live: true }))) return null;
    return Math.min(SERVICE_POLL_MAX_S, 2 ** errors);
  }
}

async function absorb(orgId: string, row: JobsTable, conn: ServiceConnectionRef, job: RemoteServiceJob, attempt: number): Promise<number | null> {
  const common = {
    progress: typeof job.progress === "number" ? job.progress : row.progress,
    message: typeof job.message === "string" ? job.message.slice(0, 300) : row.message,
    service_version: job.service_version ?? row.service_version,
    poll_errors: 0,
  };
  if (job.status === "done") {
    const decl = conn.manifest.capabilities.find((c) => c.id === row.capability);
    const check = decl ? validateAgainst(decl.output_schema, conn.manifest.$defs, job.output) : { ok: false as const, errors: ["the capability is gone from the service's manifest"] };
    if (!check.ok) {
      // A result that fails its schema is a failed job naming the service,
      // never data in a workspace.
      await finish(orgId, row, "failed", { ...common, error: failure("internal", `${conn.manifest.name} answered outside its own schema: ${check.errors.join("; ")}`) });
      return null;
    }
    const outs: Array<{ name: string; fileId: string; sha256: string }> = [];
    for (const [name, f] of Object.entries(job.files ?? {})) {
      const res = await port!.fetch(conn.credentialId, { method: "GET", path: `/blobs/${f.sha256}` });
      if (res.status !== 200) throw new RetryableHop(hopError(res));
      if (sha256(res.body) !== f.sha256) {
        await finish(orgId, row, "failed", { ...common, error: failure("hash_mismatch", `the "${name}" file did not match the hash the service gave`) });
        return null;
      }
      const written = await platform().files.write(orgId, res.body, { filename: f.name ?? name, mimeType: f.type ?? "application/octet-stream" });
      if (!written) throw new ServicesNotReadyError("storing output files");
      outs.push({ name, fileId: written.fileId, sha256: f.sha256 });
    }
    await recordOutputs(orgId, row, outs);
    await finish(orgId, row, "done", { ...common, output: job.output ?? null, progress: 1, needs: null });
    return null;
  }
  if (job.status === "failed" || job.status === "cancelled") {
    await finish(orgId, row, job.status, { ...common, error: job.error ?? failure("internal", `the service says the job ${job.status}`) });
    return null;
  }
  const status: ServiceJobStatus = job.status === "needs_input" ? "needs_input" : job.status === "queued" ? "queued" : "running";
  const needs = status === "needs_input" ? await keepNeedsFiles(orgId, row, conn, job.needs ?? null) : null;
  const next = await update(orgId, row.id, { ...common, status, needs }, { gen: row.attempt, live: true });
  if (!next) return null;
  if (next.status !== row.status || next.progress !== row.progress) await emit(orgId, next);
  if (status === "needs_input") return NEEDS_INPUT_POLL_S;
  return Math.min(SERVICE_POLL_MAX_S, Math.max(2, 2 ** Math.min(attempt, 6)));
}

/** A question's files (a preview of two designs to pick from) copied into
 *  core-files so the job card can show them beside the question; each entry
 *  gains its `file_id`. A file already copied for this question is reused. */
async function keepNeedsFiles(orgId: string, row: JobsTable, conn: ServiceConnectionRef, needs: RemoteServiceJob["needs"] | null): Promise<RemoteServiceJob["needs"] | null> {
  if (!needs?.files) return needs;
  const held = ((row.needs as { files?: Record<string, { sha256?: string; file_id?: string }> } | null)?.files ?? {}) as Record<string, { sha256?: string; file_id?: string }>;
  const files: Record<string, (typeof needs.files)[string]> = {};
  for (const [name, f] of Object.entries(needs.files)) {
    const before = held[name];
    if (before?.file_id && before.sha256 === f.sha256) {
      files[name] = { ...f, file_id: before.file_id };
      continue;
    }
    const res = await port!.fetch(conn.credentialId, { method: "GET", path: `/blobs/${f.sha256}` });
    if (res.status !== 200 || sha256(res.body) !== f.sha256) {
      files[name] = { ...f };
      continue;
    }
    const written = await platform().files.write(orgId, res.body, { filename: f.name ?? name, mimeType: f.type ?? "application/octet-stream" });
    if (written) await platform().files.attach(orgId, { fileId: written.fileId, source_module: "platform", source_type: "service-job", source_id: row.id, role: `needs:${name}` }).catch(() => null);
    files[name] = written ? { ...f, file_id: written.fileId } : { ...f };
  }
  return { ...needs, files };
}

// ── The supervisor's hands (service-supervisor.ts decides when) ─────────

/** Try a stalled job again, once, where it is: a poll now, outside the
 *  chain's own schedule. Marks it stalled so the next look can tell whether
 *  the nudge moved it. */
export async function nudgeStalled(orgId: string, jobId: string, now: Date): Promise<void> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row || !["queued", "running"].includes(row.status)) return;
  await db.updateTable("core_services_jobs").set({ stalled_at: now } as never).where("id", "=", jobId).where("attempt", "=", row.attempt).execute();
  // A built-in runs in this process: polling it again would run it twice.
  if (row.built_in) return;
  await platform().queue.enqueue({ orgId, queue: POLL_QUEUE, payload: { jobId, gen: row.attempt, step: 0 }, idempotencyKey: `services.job:${jobId}:g${row.attempt}:nudge:${now.getTime()}`, maxAttempts: 1 });
}

/** A stalled job, given up on where it is: handed to the next in the order
 *  (never a pinned one, never one that acts in the world or spends, whose yes
 *  was for this service; at most SERVICE_MAX_HANDOFFS times), else failed with
 *  error `stalled`. The old attempt's late answer changes nothing. */
export async function handOn(orgId: string, jobId: string, why: string): Promise<"handed_on" | "failed" | null> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row || !["queued", "running"].includes(row.status)) return null;
  const here = await declOf(row);
  const label = here?.label ?? "the service";
  const routes = await routesFor(orgId, row.requested_by, row.capability);
  const at = routes.findIndex((r) => (r.connection?.credentialId ?? null) === row.connection_id && (r.builtIn?.id ?? null) === row.built_in);
  const nextRoute = at >= 0 ? routes[at + 1] : undefined;
  const effect = here?.decl.effect ?? "physical";
  if (nextRoute && !row.pinned && effect === "none" && row.attempt < SERVICE_MAX_HANDOFFS) {
    if (row.connection_id && row.remote_job_id && port) {
      await port.fetch(row.connection_id, { method: "POST", path: `/jobs/${encodeURIComponent(row.remote_job_id)}/cancel` }).catch(() => null);
    }
    const next = await update(
      orgId,
      row.id,
      {
        connection_id: nextRoute.connection?.credentialId ?? null,
        built_in: nextRoute.builtIn?.id ?? null,
        manifest_version: nextRoute.connection?.manifestVersion ?? null,
        remote_job_id: null,
        status: "queued",
        progress: null,
        message: `Handed on to ${nextRoute.step.label}: ${label} ${why}.`,
        poll_errors: 0,
        attempt: row.attempt + 1,
        stalled_at: null,
      },
      { gen: row.attempt, live: true },
    );
    if (!next) return null;
    await emit(orgId, next);
    await startQueuedJob(orgId, row.id);
    return "handed_on";
  }
  // Acting in the world: stop watching, but never tell the service to stop a
  // thing a person may be standing next to.
  if (effect === "none" && row.connection_id && row.remote_job_id && port) {
    await port.fetch(row.connection_id, { method: "POST", path: `/jobs/${encodeURIComponent(row.remote_job_id)}/cancel` }).catch(() => null);
  }
  const reason =
    effect === "none"
      ? `${label} ${why}, and there was no one else to hand it to.`
      : `${label} ${why}. It may still be going there; Cobblr stopped waiting for it.`;
  await finish(orgId, row, "failed", { error: failure("stalled", reason), message: reason, stalled_at: row.stalled_at ?? new Date() });
  return "failed";
}

/** A person's Retry: the same call again as a new job, beside the one that
 *  failed (nothing leaves a terminal state). For something that acts in the
 *  world, the press is that person's yes: the new job is confirmed as them,
 *  under the same rule as any confirm. */
export async function retryJob(orgId: string, jobId: string, userId: string): Promise<ServiceJobRef> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row) throw new ServiceRefusal("bad_request", "There is no such job here.");
  if (row.status !== "failed" && row.status !== "cancelled") throw new ServiceRefusal("bad_request", `This step is ${row.status.replace("_", " ")}, not stopped: there is nothing to retry.`);
  const already = await db.selectFrom("core_services_jobs").select(["id", "status"]).where("retry_of", "=", row.id).orderBy("created_at", "desc").executeTakeFirst();
  if (already && !TERMINAL_JOB_STATUSES.has(already.status)) return { id: already.id, status: already.status };
  const files = await db.selectFrom("core_services_job_files").select(["name", "file_id"]).where("job_id", "=", row.id).where("direction", "=", "in").execute();
  const tries = await db.selectFrom("core_services_jobs").select((eb) => eb.fn.countAll<string>().as("n")).where("retry_of", "=", row.id).executeTakeFirstOrThrow();
  const ref = await invokeAs(
    { origin: "person", userId },
    {
      orgId,
      capability: row.capability,
      input: row.input,
      ...(files.length ? { files: Object.fromEntries(files.map((f) => [f.name, f.file_id])) } : {}),
      ...(row.caused_by_job ? { causedByJob: row.caused_by_job } : {}),
      ...(attachToOf(row.attach_to) ? { attachTo: attachToOf(row.attach_to)! } : {}),
      idempotencyKey: `retry:${row.id}:${Number(tries.n)}`,
    },
  );
  await db.updateTable("core_services_jobs").set({ retry_of: row.id } as never).where("id", "=", ref.id).execute();
  if (ref.status === "awaiting_confirm") {
    await confirmImpl(orgId, ref.id, userId);
    return { id: ref.id, status: "queued" };
  }
  return ref;
}

/** Whether a step can be skipped: its answer can be absent, because the
 *  capability promises no field in it. */
export async function skippable(orgId: string, jobId: string): Promise<boolean> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row || (row.status !== "failed" && row.status !== "cancelled") || row.skipped_at) return false;
  const schema = (await declOf(row))?.decl.output_schema as { required?: unknown[] } | undefined;
  return !!schema && !(Array.isArray(schema.required) && schema.required.length > 0);
}

/** A person's Skip: the step stays failed, and the run goes on without its
 *  answer: `services.job.skipped`, then `services.job.done` with `skipped`. */
export async function skipJob(orgId: string, jobId: string, userId: string): Promise<void> {
  if (!(await skippable(orgId, jobId))) throw new ServiceRefusal("bad_request", "This step cannot be skipped: what comes after it needs its answer.");
  const db = await tdb(orgId);
  const row = (await db
    .updateTable("core_services_jobs")
    .set({ skipped_by: userId, skipped_at: new Date(), updated_at: new Date() } as never)
    .where("id", "=", jobId)
    .where("skipped_at", "is", null)
    .returningAll()
    .executeTakeFirst()) as JobsTable | undefined;
  if (!row) return;
  const attachTo = attachToOf(row.attach_to);
  const payload = { orgId, jobId: row.id, capability: row.capability, status: "done", causedByJob: row.caused_by_job, hop: row.hop, skipped: true, ...(attachTo ? { attachTo } : {}) };
  await platform().events.emit("services.job.skipped", payload);
  await platform().events.emit("services.job.done", payload);
}

/** Every job in the chain `jobId` belongs to, from the one that started it. */
export async function runRows(orgId: string, jobId: string): Promise<JobsTable[]> {
  const db = await tdb(orgId);
  // Up to the job that started it (a retry of the first step leads back to
  // the step it retried), then down every job that followed from there.
  const { rows } = await sql<JobsTable>`
    with recursive up(id, parent, depth) as (
      select id, coalesce(caused_by_job, retry_of), 0 from core_services_jobs where id = ${jobId}
      union all
      select j.id, coalesce(j.caused_by_job, j.retry_of), up.depth + 1 from core_services_jobs j join up on j.id = up.parent where up.depth < 64
    ),
    down(id, depth) as (
      select id, 0 from up where parent is null
      union all
      select j.id, down.depth + 1 from core_services_jobs j join down on j.caused_by_job = down.id or (j.caused_by_job is null and j.retry_of = down.id) where down.depth < 64
    )
    select distinct j.* from core_services_jobs j join down on down.id = j.id
    order by j.created_at`.execute(db);
  return rows;
}

/** The jobs that started the most recent runs here (no cause, not a retry). */
export async function recentRunRoots(orgId: string, limit: number): Promise<string[]> {
  const db = await tdb(orgId);
  const rows = await db
    .selectFrom("core_services_jobs")
    .select("id")
    .where("caused_by_job", "is", null)
    .where("retry_of", "is", null)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => r.id);
}

/** Who answers a job, as the run shows it. */
export async function answererOf(row: Pick<JobsTable, "built_in" | "connection_id" | "capability">): Promise<{ label: string; title: string } | null> {
  const d = await declOf(row);
  return d ? { label: d.label, title: d.decl.title } : null;
}

// ── Retention ───────────────────────────────────────────────────────────

export const RETENTION_PASS = "core-services.retention";
const READING_KEEP_MS = 24 * 3600_000;
const RETENTION_PAGE = 5000;

/** Forget readings: a job a module or wire asked for that finished cleanly a
 *  day ago and left nothing behind (no file, no attachment, nothing it led
 *  to). A print watch reading every few seconds would otherwise keep a row
 *  per frame forever. Anything a person asked for, anything that failed,
 *  produced a file, is attached to a record or started another job is kept,
 *  so a Make's history never loses a step. */
export async function forgetReadings(db: Kysely<ServicesDB>, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - READING_KEEP_MS);
  const gone = await db
    .deleteFrom("core_services_jobs")
    .where("id", "in", (eb) =>
      eb
        .selectFrom("core_services_jobs as j")
        .select("j.id")
        .where("j.status", "=", "done")
        .where("j.origin", "in", ["module", "wire"])
        .where("j.finished_at", "<", cutoff)
        .where("j.attach_to", "is", null)
        .where((w) => w.not(w.exists(w.selectFrom("core_services_job_files as f").select("f.job_id").whereRef("f.job_id", "=", "j.id").where("f.direction", "=", "out"))))
        .where((w) => w.not(w.exists(w.selectFrom("core_services_jobs as c").select("c.id").whereRef("c.caused_by_job", "=", "j.id"))))
        .limit(RETENTION_PAGE),
    )
    .executeTakeFirst();
  return Number(gone.numDeletedRows ?? 0);
}

let retentionRegistered = false;
export function registerServicesRetention(): void {
  if (retentionRegistered) return;
  retentionRegistered = true;
  platform().sweeps.register({
    name: RETENTION_PASS,
    everyMs: 6 * 3600_000,
    drainMs: 60_000,
    visit: async ({ db, now }) => {
      const n = await forgetReadings(db as Kysely<ServicesDB>, now);
      return { backlog: n >= RETENTION_PAGE };
    },
  });
}

let workerRegistered = false;
export function registerServicesWorker(): void {
  if (workerRegistered) return;
  workerRegistered = true;
  platform().queue.registerWorker(POLL_QUEUE, async (q) => {
    const jobId = String(q.payload.jobId ?? "");
    if (!jobId) return;
    const attempt = Number(q.payload.step ?? 0);
    const gen = Number(q.payload.gen ?? 0);
    const next = await step(q.orgId, jobId, attempt, gen);
    if (next != null) {
      // The next step is its own queue row, so the one running now finishes and
      // a restart finds exactly one waiting.
      await platform().queue.enqueue({ orgId: q.orgId, queue: POLL_QUEUE, payload: { jobId, gen, step: attempt + 1 }, idempotencyKey: `services.job:${jobId}:g${gen}:${attempt + 1}`, runAt: new Date(Date.now() + next * 1000), maxAttempts: 5 });
    }
  });
}

// ── Answer, cancel, and the listing ─────────────────────────────────────

async function answer(orgId: string, jobId: string, input: unknown, _userId: string): Promise<void> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row) throw new ServiceRefusal("bad_request", "no such job");
  if (row.status !== "needs_input") throw new ServiceRefusal("bad_request", "this job is not waiting for an answer");
  const needs = row.needs as { input_schema?: Record<string, unknown> } | null;
  if (needs?.input_schema) {
    const conn = row.connection_id && port ? await port.byId(row.connection_id) : null;
    const check = validateAgainst(needs.input_schema, conn?.manifest.$defs, input);
    if (!check.ok) throw new ServiceRefusal("invalid_input", `the answer does not fit: ${check.errors.join("; ")}`);
  }
  if (!row.connection_id || !row.remote_job_id || !port) throw new ServiceRefusal("bad_request", "this job cannot take an answer");
  const res = await port.fetch(row.connection_id, { method: "POST", path: `/jobs/${encodeURIComponent(row.remote_job_id)}/input`, body: JSON.stringify({ input }), headers: { "content-type": "application/json" } });
  if (res.status !== 202 && res.status !== 200) throw new ServiceRefusal("bad_request", hopError(res).message);
  const next = await update(orgId, row.id, { status: "running", needs: null }, { gen: row.attempt, live: true });
  if (!next) throw new ServiceRefusal("bad_request", "this job has moved on");
  await emit(orgId, next);
  await startQueuedJob(orgId, row.id);
}

async function cancel(orgId: string, jobId: string, _userId: string | null): Promise<void> {
  const db = await tdb(orgId);
  const row = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as JobsTable | undefined;
  if (!row) throw new ServiceRefusal("bad_request", "no such job");
  if (TERMINAL_JOB_STATUSES.has(row.status)) return;
  if (row.connection_id && row.remote_job_id && port) {
    await port.fetch(row.connection_id, { method: "POST", path: `/jobs/${encodeURIComponent(row.remote_job_id)}/cancel` }).catch(() => null);
  }
  await finish(orgId, row, "cancelled", { error: failure("x-cancelled", "cancelled") });
}

async function capabilities(orgId: string, userId: string | null): Promise<ServiceCapabilityView[]> {
  const ids = new Set<string>();
  for (const b of builtIns.values()) ids.add(b.capability.id);
  for (const c of port ? await port.list(orgId, userId) : []) for (const cap of c.manifest.capabilities) ids.add(cap.id);
  const out: ServiceCapabilityView[] = [];
  for (const id of [...ids].sort()) {
    const routes = await routesFor(orgId, userId, id);
    const first = routes[0];
    if (!first) continue;
    out.push({
      id,
      title: first.decl.title,
      summary: first.decl.summary,
      // The strongest any answerer declares: a person is asked by the most
      // careful reading, never the least.
      effect: routes.reduce<ServiceEffect>((e, r) => strongerEffect(e, r.decl.effect), first.decl.effect),
      input_schema: first.decl.input_schema,
      files_in: first.decl.files_in ?? [],
      answered_by: routes.map((r) => r.step),
    });
  }
  return out;
}

const OPTIONS_TTL_MS = 10 * 60_000;
const optionsCache = new Map<string, { at: number; options: unknown }>();

/** One capability as this person sees it here, with the live choices its
 *  first answerer serves (printer models, templates) from its
 *  options_endpoint, cached per connection for a few minutes. Null when
 *  nothing here does it. */
export async function capabilityDetail(orgId: string, userId: string | null, capability: string): Promise<(ServiceCapabilityView & { options: unknown | null }) | null> {
  const view = (await capabilities(orgId, userId)).find((c) => c.id === capability);
  if (!view) return null;
  const routes = await routesFor(orgId, userId, capability);
  const route = routes.find((r) => r.connection && r.decl.options_endpoint);
  if (!route?.connection || !port) return { ...view, options: null };
  const key = `${route.connection.credentialId}|${capability}`;
  const cached = optionsCache.get(key);
  if (cached && Date.now() - cached.at < OPTIONS_TTL_MS) return { ...view, options: cached.options };
  const base = route.connection.manifest.api.base_path;
  const endpoint = route.decl.options_endpoint!;
  const path = endpoint.startsWith(base) ? endpoint.slice(base.length) || "/" : endpoint;
  try {
    const res = await port.fetch(route.connection.credentialId, { method: "GET", path });
    const options = res.status === 200 ? parseBody<unknown>(res) : null;
    if (options != null) optionsCache.set(key, { at: Date.now(), options });
    return { ...view, options };
  } catch {
    return { ...view, options: cached?.options ?? null };
  }
}

export function createServices(): PlatformServices {
  return {
    capabilities,
    chainFor: async (orgId, userId, capability) => ({ steps: (await routesFor(orgId, userId, capability)).map((r) => r.step) }),
    invoke: (req) => invokeAs({ origin: "module", userId: null }, req),
    job: readJob,
    answer,
    confirm: (orgId, jobId, userId) => confirmImpl(orgId, jobId, userId),
    cancel,
    run: async (orgId, jobId) => {
      if (!supervisor) throw new ServicesNotReadyError("reading a run");
      return supervisor.run(orgId, jobId);
    },
    raiseStuck: async (n) => {
      if (!supervisor) throw new ServicesNotReadyError("raising a stuck notice");
      return supervisor.raiseStuck(n);
    },
    settleStuck: async (orgId, subjectId) => {
      if (!supervisor) throw new ServicesNotReadyError("settling a stuck notice");
      return supervisor.settleStuck(orgId, subjectId);
    },
    adapterConfig: async (orgId, credentialId, builtInId) => {
      if (!port?.configFor) return null;
      // Only a connection this workspace can use, and only one of this adapter.
      const mine = (await port.list(orgId, null)).find((c) => c.credentialId === credentialId);
      const def = builtIns.get(builtInId);
      if (!mine || !def || mine.adapter !== adapterGroupOf(def)) return null;
      return port.configFor(credentialId);
    },
    connectionsFor: async (orgId, capability) => (port?.holders ? port.holders(orgId, capability) : []),
    adapterMetadata: (group) => {
      const metadata = adapterMetadata.get(group);
      return metadata ? structuredClone(metadata) : null;
    },
    registerBuiltIn: (def) => {
      if (builtIns.has(def.id)) throw new Error(`services: a built-in ${def.id} is already registered`);
      if (!isServiceCapabilityId(def.capability.id)) throw new Error(`services: ${def.id} offers "${def.capability.id}", which is not a dotted capability id`);
      const group = adapterGroupOf(def);
      const metadata = def.connection?.metadata;
      if (metadata) {
        const existing = adapterMetadata.get(group);
        if (existing && !isDeepStrictEqual(existing, metadata)) throw new Error(`services: conflicting metadata for adapter ${group}`);
        for (const ref of metadata.library?.push?.refs ?? []) if (ref.pattern) new RegExp(ref.pattern);
        adapterMetadata.set(group, structuredClone(metadata));
      }
      builtIns.set(def.id, def);
    },
  };
}
