import { persistCncRuntime } from "./cnc-runtime.js";
import { releaseUnstartedCncStock, validateCncStock } from "./cnc-start.js";
import {verifyLargePrint} from "./large-format/service.js";
import { authorizeCutterStart, requireCutterStation } from "./cutter-station.js";
import { verifyCutterPlan } from "./cutter-plans.js";
import { reserveResinPrint, checkResinStart, setResinPhase, settleResinPrint } from "./resin-prints.js";
// Shared job logic — building a driver from a stored connection, and
// polling a job's status. No express dependency, so both the HTTP route
// and the core-queue poll worker use the same code.

import { interpretReport, plainDriverError, unreachablePlan, POLL_MS } from "./job-truth.js";
import { persistResinStart } from "./resin-start.js";
import { enqueuePoll } from "./poll-worker.js";
import { extractPlateMetadata } from "./library/extract-metadata.js";
import { printerMaterialRefusal } from "./material-dispatch.js";
import { machineOfJob } from "./loaded-spools.js";
import { drawForCompletedJob } from "./loaded-spools.js";
import { settleMakeForJob } from "./makes-core.js";
import { platform } from "@cobblr/platform-contract";
import { takeBatchStartPermit, type BatchStartPermit } from "./batch-start-permit.js";
import { isEdgeManagerUrl, edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";
import type { Kysely, Selectable } from "kysely";
import type { DigifabDB } from "./db.js";
import { submitReviewedJob, ReviewRequired, InterruptedStart } from "./drivers/job-review.js";
import { verifyLaserOutput } from "./laser-layout.js";
import { authorizeLaserStart, stationTokenHash } from "./laser-station.js";
import type { JobApproval } from "./drivers/types.js";
import { resolveDriver } from "./drivers/registry.js";
import { EdgeAdapterDriver, type EdgeRelay } from "./drivers/edge-adapter.js";
import type { CommandResult, MachineDriver, RemoteDevice, SubmitResult } from "./drivers/types.js";
import { isAssignable } from "./state.js";
import { randomUUID } from "node:crypto";
import { notifyPrint, progressBucket } from "./notify.js";
// Call-time only (reprint-on-fail re-queue) — lazy/circular by design; ESM
// resolves it when the retry fires.
import { kickAssign } from "./assign-worker.js";
import { edgeChannelKey } from "@cobblr/platform-contract/edge-channel";

/** The manual camera URL set for a device (for the "Live view" link in print
 *  notifications). Null when none or no device. */
async function cameraFor(db: Kysely<DigifabDB>, connectionId: string | null, deviceId: string | null): Promise<string | null> {
  if (!connectionId || !deviceId) return null;
  const row = await db
    .selectFrom("digifab_device_settings")
    .select(["camera_url"])
    .where("connection_id", "=", connectionId)
    .where("remote_device_id", "=", deviceId)
    .executeTakeFirst();
  return row?.camera_url ?? null;
}

/** What a person calls the manager a job runs on ("Shop OctoPrint"), for the
 *  sentences a failure puts on the job. */
export async function managerName(orgId: string, connectionId: string | null): Promise<string> {
  if (!connectionId) return "the printer's manager";
  const c = await platform().devices.connections().get(orgId, connectionId).catch(() => null);
  return c?.label?.trim() || "the printer's manager";
}

export const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Is a job in this status physically holding its target printer?
 *
 *  DERIVED, never an allowlist. Everything that isn't finished and isn't still
 *  waiting in the queue is on the machine: `assigning` (claimed, mid-sendJob),
 *  `awaiting-assignment` (uploaded, manager hasn't started it), `sent`,
 *  `printing`, `paused` (the part is still on the bed). A status added later
 *  counts as occupying until someone deliberately excludes it, because the two
 *  mistakes don't cost the same: a false "busy" delays a plate by one tick, a
 *  false "free" drops a second plate onto an occupied bed.
 *
 *  The assign worker used to hardcode `["sent", "printing"]`, which omitted
 *  `assigning` — the status set immediately BEFORE the awaited sendJob (a file
 *  upload, so the window is seconds wide on a real manager). Two overlapping
 *  passes (kickAssign on create, the 15s re-tick, pollJob's terminal kick) both
 *  read a mid-send printer as free and dispatched to it. `awaiting-assignment`
 *  and `paused` had the same hole. */
export function occupiesDevice(status: string): boolean {
  return !TERMINAL.has(status) && status !== "queued";
}

/** The same rule as occupiesDevice, as a LIST for SQL — a device is free only
 *  when every job pointing at it is in one of these statuses. Derived from
 *  TERMINAL rather than written out, so a status added to one and not the other
 *  cannot make the SQL and the JS predicate disagree (the exact drift that put
 *  `assigning` outside the old hardcoded `["sent","printing"]`). */
export const NOT_OCCUPYING_STATUSES: readonly string[] = ["queued", ...TERMINAL];

/**
 * Does ending this job leave something on the bed a human must clear?
 *
 * DERIVED from occupiesDevice for the same reason it is: if the job was on the
 * machine, whatever it produced (a finished plate, a failed blob, half a print
 * abandoned mid-layer) is still sitting there. The REASON it ended does not
 * change the physics — which is exactly what the first version of this rule got
 * wrong. It lived inline in pollJob, so it covered prints that finished on
 * their own and missed every other way a job can end: a user cancelling a
 * RUNNING print (the API 409s only if the job is already terminal, so cancel
 * mid-print is a supported, ordinary act) got no bed-clear row at all, and the
 * next queued plate could be dripped straight onto the abandoned one. An
 * aborted print leaves MORE debris than a completed one, so that was the worst
 * case wearing the thinnest guard.
 *
 * A job that never left the queue never touched a bed — hence occupiesDevice
 * on the PRIOR status, not merely "it has a target_device".
 */
export function needsBedClear(prev: {
  status: string;
  connection_id: string | null;
  target_device: string | null;
}): boolean {
  return occupiesDevice(prev.status) && !!prev.connection_id && !!prev.target_device;
}

/** What the fleet UI says on the device card. */
export function bedClearReason(status: string): string {
  if (status === "completed") return "print-completed";
  if (status === "cancelled") return "print-cancelled";
  return "print-failed";
}

/**
 * END A JOB. The only way a digifab job may reach a terminal status.
 *
 * F-1 ATOMIC: the status flip and the bed-clear (needs_attention) row commit
 * TOGETHER. Otherwise an assign pass can observe the device as "no longer
 * printing" in the gap BEFORE the attention row exists and drip the next queued
 * job straight onto the uncleared bed.
 *
 * It is a shared helper rather than a transaction copied into each caller
 * because copying is how the rule got holes: the original lived inline in
 * pollJob, so it protected the one path someone was thinking about and left
 * user-cancel, connection-removal and assignment-failure writing a bare status
 * with no bed-clear row. lint:digifab-terminal-jobs keeps it that way.
 */
export async function markJobTerminal(
  db: Kysely<DigifabDB>,
  prev: { id: string; status: string; connection_id: string | null; target_device: string | null },
  status: "completed" | "failed" | "cancelled",
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const bedClear = needsBedClear(prev);
  let claimed = false;
  const write = async (trx: Kysely<DigifabDB>) => {
    // A CLAIM, not a write: only a caller that finds the job still live ends
    // it. Two polls landing together at the finish (the worker and a Refresh,
    // or two tabs) both read "printing" and both got here; each then emitted
    // print.completed and each charged the spool (#4031: 120 g for a 40 g
    // print). The loser now learns it lost and emits nothing.
    const r = await trx
      .updateTable("digifab_jobs")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ status, updated_at: new Date(), ...extra } as any)
      .where("id", "=", prev.id)
      .where("status", "not in", [...TERMINAL])
      .executeTakeFirst();
    claimed = Number(r.numUpdatedRows ?? 0) > 0;
    if (!claimed || !bedClear) return;
    await trx
      .insertInto("digifab_device_attention")
      .values({
        connection_id: prev.connection_id!,
        remote_device_id: prev.target_device!,
        job_id: prev.id,
        reason: bedClearReason(status),
      })
      .onConflict((oc) =>
        oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({
          job_id: prev.id,
          reason: bedClearReason(status),
          created_at: new Date(),
        }),
      )
      .execute();
  };
  // Callers inside an existing transaction pass it straight in — opening a
  // nested one on a second connection would sit behind the outer transaction's
  // own locks on these rows.
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) await write(db);
  else await db.transaction().execute(write);
  return claimed;
}

/** The poll pace. The mock is fast for tests and demos; how long an
 *  unreachable manager is tolerated is unreachablePlan's call (job-truth.ts). */
/** A mock connection's pace: every 4 s, or what its URL asks for (`mock://farm?poll_ms=1000`, 250 to
 *  4000 ms), so a test that prints three plates waits seconds, not the demo's rhythm (#5443). */
export function mockPollMs(baseUrl: string | null | undefined): number {
  const m = /[?&]poll_ms=(\d+)/.exec(baseUrl ?? "");
  return Math.min(4_000, Math.max(250, m ? Number(m[1]) : 4_000));
}

export function pollTuning(conn: { type?: string | null; base_url?: string | null } | null): { intervalMs: number; fast: boolean } {
  return conn?.type === "mock" ? { intervalMs: mockPollMs(conn.base_url), fast: true } : { intervalMs: POLL_MS, fast: false };
}

/** Build a live driver from a connection ref (id OR label; decrypts creds). The
 *  connection now lives in core-devices — fetch it via the platform store; the
 *  digifab db is still needed for the installed-driver (digifab_drivers) lookup. */
export async function buildDriverById(
  db: Kysely<DigifabDB>,
  orgId: string,
  connectionRef: string,
): Promise<MachineDriver | null> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionRef);
  if (!conn) return null;
  let creds: Record<string, unknown> = {};
  if (conn.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  }
  return resolveDriver(
    db,
    conn.type,
    {
      baseUrl: conn.base_url,
      apiKey: (creds.apiKey as string | undefined) ?? null,
      username: (creds.username as string | undefined) ?? null,
      password: (creds.password as string | undefined) ?? null,
      extra: { creds },
    },
    conn.id,
    buildEdgeRelay(orgId, conn.base_url, creds.edge as { driver?: unknown; config?: unknown } | undefined, creds.shared as { owner_org?: unknown } | undefined),
  );
}

/** The driver config to ship down the tunnel for an edge instance. `creds.edge`
 *  is stored FLAT by connections.ts — `{ driver, host, apiKey, … }` — so the
 *  driver's config is every field EXCEPT `driver`. (A bug shipped where this read
 *  a nested `edge.config` that's never written, so `host` was dropped and the
 *  bridge looped "prusalink driver needs host".) Tolerates a nested `{ config }`
 *  too, for forward-compat. */
function edgeDriverConfig(edge: { driver?: unknown; config?: unknown }): Record<string, unknown> {
  if (edge.config && typeof edge.config === "object") return edge.config as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edge as Record<string, unknown>)) {
    // `driver` selects the driver; `bridge` is routing metadata (which bridge
    // serves this connection) — neither is part of the driver's own config.
    if (k !== "driver" && k !== "bridge") rest[k] = v;
  }
  return rest;
}

/** The edge channel key. Multi-bridge: a workspace can run more than one bridge
 *  (separate buildings/VLANs, or LightBurn which must run on the LightBurn PC).
 *  Each named bridge gets its own channel; a connection with no bridge id routes
 *  to the workspace's DEFAULT channel — byte-identical to the single-bridge path,
 *  so existing bridges are untouched. The agent announces the same id via
 *  `?bridge=` on register/poll/respond. */
export { edgeChannelKey };

/** Per-printer Bambu LAN config — `creds.bambu_lan` is a JSON map of
 *  serial → { host, access_code } (the access code is a credential, so it lives
 *  encrypted in creds, not plaintext config). HYBRID: a Bambu connection keeps
 *  its cloud telemetry AND, for any printer with LAN config here, routes
 *  file-push + control through the on-site bridge's `bambu` (LAN) driver. */
/** Per-printer transport mode: all cloud / prefer LAN (cloud fallback) / LAN only
 *  (cloud off, accept losing cloud-only history). Default = prefer_lan once LAN
 *  is configured. */
export type BambuLanMode = "cloud" | "prefer_lan" | "lan_only";
export type BambuLan = { host: string; access_code: string; mode?: BambuLanMode };
export function bambuLanMode(lan: BambuLan | undefined): BambuLanMode {
  return lan?.mode ?? (lan?.host ? "prefer_lan" : "cloud");
}
export function parseBambuLan(creds: Record<string, unknown>): Record<string, BambuLan> {
  try {
    const m = JSON.parse(String(creds.bambu_lan ?? "{}")) as Record<string, BambuLan>;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/** Build the edge-routed `bambu` LAN driver for one printer — the bridge dials
 *  the printer over `mqtts://host:8883` (+ FTPS file push) using the access code.
 *  Each printer is its own bridge instance (`bambu-<serial>`); rides the org's
 *  default bridge channel (same bridge that serves the workspace's other LAN
 *  machines). */
export function buildBambuLanDriver(orgId: string, serial: string, lan: BambuLan, bridge?: string | null): MachineDriver {
  const baseUrl = `cobblr-edge://bambu-${serial}`;
  const relay = buildEdgeRelay(orgId, baseUrl, { driver: "bambu", transport: "lan", host: lan.host, serial, accessCode: lan.access_code, ...(bridge ? { bridge } : {}) } as Record<string, unknown>, null);
  return new EdgeAdapterDriver({ baseUrl, apiKey: null, username: null, password: null, extra: {} }, relay);
}

/** If this connection is Bambu AND `deviceId` has LAN config, return the LAN
 *  driver (for file-push/control); else null (cloud handles it). */
export async function bambuLanDriverFor(orgId: string, connectionRef: string, deviceId: string): Promise<MachineDriver | null> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionRef);
  if (!conn || conn.type !== "bambu" || !conn.credentials_enc) return null;
  const creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  const lan = parseBambuLan(creds)[deviceId];
  // "All cloud" mode ignores LAN even if the host/code are stored.
  if (!lan?.host || !lan?.access_code || bambuLanMode(lan) === "cloud") return null;
  return buildBambuLanDriver(orgId, deviceId, lan);
}

/** Run a control, falling back to the cloud driver when the LAN/edge-bridge path
 *  failed. A flaky bridge (or a printer that's off the LAN) shouldn't block a
 *  command the cloud broker can ALSO send — the chamber light, pause/resume/stop,
 *  temps. It only falls back when LAN was the primary (`lanPrimary`); the cloud
 *  driver rejects an id it doesn't know, so a LAN-only control still surfaces its
 *  failure honestly, and the original LAN detail is preserved when cloud can't
 *  help either. `buildCloud` is lazy so the cloud driver is only built on failure.
 *
 *  Why this exists: a prefer_lan printer routed a chamber-light command through a
 *  failing edge bridge and 502'd, even though the live cloud pump could publish it
 *  (2026-07-22). "Prefer LAN" must not mean "never try the working cloud path." */
export async function runControlWithCloudFallback(opts: {
  primary: MachineDriver;
  lanPrimary: boolean;
  buildCloud: () => Promise<MachineDriver | null>;
  deviceId: string;
  id: string;
  params: Record<string, unknown>;
  onFallback?: (lanDetail: string | undefined) => void;
}): Promise<CommandResult> {
  const r = await opts.primary.runControl!(opts.deviceId, opts.id, opts.params);
  if (r.ok || !opts.lanPrimary) return r;
  const cloud = await opts.buildCloud();
  if (!cloud?.runControl || cloud === opts.primary) return r;
  const cr = await cloud.runControl(opts.deviceId, opts.id, opts.params);
  if (!cr.ok) return r; // cloud can't help either — keep the LAN driver's detail
  opts.onFallback?.(r.detail);
  return cr;
}

/** The cloud→edge tunnel relay closure for a `cobblr-edge://` connection: routes
 *  every edge-adapter call through the agent that dialed out (platform().edge),
 *  so the cloud never fetches a private IP (no SSRF surface). Null for a direct
 *  `http(s)://` bridge URL. Shared by every driver-build path (jobs, fleet,
 *  connection test/listDevices) so the tunnel works end to end, not just for jobs. */
export function buildEdgeRelay(
  orgId: string,
  baseUrl: string,
  edge?: { driver?: unknown; config?: unknown } | null,
  shared?: { owner_org?: unknown; owner_conn_id?: unknown; share_id?: unknown; scope?: unknown } | null,
): EdgeRelay | null {
  if (!isEdgeManagerUrl(baseUrl)) return null;
  const id = edgeInstanceOf(baseUrl) ?? "";

  // SHARED pointer (this connection was redeemed from another workspace's invite).
  // Route through the OWNER's bridge channel, assembling the request from the
  // owner's machine config SERVER-SIDE (their creds never reach this workspace),
  // and enforce the grant LIVE on every call: revoked/expired → blocked; read
  // scope → GET only, so every upload/submit/command/pause (POST) is refused.
  const ownerOrg = typeof shared?.owner_org === "string" ? shared.owner_org : null;
  const ownerConnId = typeof shared?.owner_conn_id === "string" ? shared.owner_conn_id : null;
  const shareId = typeof shared?.share_id === "string" ? shared.share_id : null;
  if (ownerOrg && ownerConnId && shareId) {
    const scope = shared?.scope === "write" ? "write" : "read";
    return async (r) => {
      const method = r.method === "POST" ? "POST" : "GET";
      if (scope === "read" && method !== "GET") {
        return { status: 403, body: { error: { code: "read_only", message: "This shared machine is read-only." } } };
      }
      const odb = (await platform().tenants.getDb(ownerOrg)) as Kysely<DigifabDB>;
      try {
        const grant = await odb
          .selectFrom("digifab_edge_shares")
          .select(["revoked_at", "expires_at"])
          .where("id", "=", shareId)
          .executeTakeFirst();
        if (!grant || grant.revoked_at || (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now())) {
          return { status: 403, body: { error: { code: "revoked", message: "Access to this shared machine was revoked." } } };
        }
        const oc = await platform().devices.connections().getInternal(ownerOrg, ownerConnId);
        if (!oc?.credentials_enc) return { status: 502, body: { error: { code: "unavailable", message: "Shared machine unavailable." } } };
        const ownerCreds = (await platform().integrations.decryptCredentials(ownerOrg, oc.credentials_enc)) as { edge?: { driver?: unknown; config?: unknown } };
        const oe = ownerCreds.edge;
        const instance = id && oe && typeof oe.driver === "string" && oe.driver ? { id, driver: oe.driver, config: edgeDriverConfig(oe) } : undefined;
        const oeBridge = typeof (oe as { bridge?: unknown } | undefined)?.bridge === "string" ? ((oe as { bridge?: string }).bridge as string) : null;
        const res = await platform().edge.send(edgeChannelKey(ownerOrg, oeBridge), { path: r.path, method, body: r.body, ...(instance ? { instance } : {}), ...(r.file ? { bodyFile: r.file } : {}), ...(r.timeoutMs ? {timeoutMs:r.timeoutMs} : {}) });
        void odb.updateTable("digifab_edge_shares").set({ last_used_at: new Date() }).where("id", "=", shareId).execute().catch(() => {});
        return { status: res.status, body: res.body };
      } finally {
        await platform().tenants.releaseIdleDb(ownerOrg);
      }
    };
  }

  // OWNER's own machine: the instance segment + the machine's config (driver +
  // host + key) ride WITH the request so a dynamic-config bridge configures the
  // driver on the fly. Omitted if no config stored (a static bridge routes by path).
  const instance = id && edge && typeof edge.driver === "string" && edge.driver
    ? { id, driver: edge.driver, config: edgeDriverConfig(edge) }
    : undefined;
  // Which bridge serves this connection (null = the workspace default bridge).
  const ownBridge = typeof (edge as { bridge?: unknown } | undefined)?.bridge === "string" ? ((edge as { bridge?: string }).bridge as string) : null;
  const ownKey = edgeChannelKey(orgId, ownBridge);
  return async (r) => {
    const res = await platform().edge.send(ownKey, {
      path: r.path,
      method: r.method === "POST" ? "POST" : "GET",
      body: r.body,
      ...(instance ? { instance } : {}),
      ...(r.file ? { bodyFile: r.file } : {}), ...(r.timeoutMs ? {timeoutMs:r.timeoutMs} : {}),
    });
    return { status: res.status, body: res.body };
  };
}

/** Poll one job: getJobStatus → persist → emit on terminal. Returns the
 *  new status + whether it's terminal (so the worker stops re-enqueuing) +
 *  the driver-appropriate re-poll interval. */
export async function pollJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
): Promise<{ status: string; terminal: boolean; intervalMs: number } | null> {
  const job = await db
    .selectFrom("digifab_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job || !job.remote_job_id || !job.connection_id) return null;
  // A job Cobblr already considers finished is NEVER overwritten by the manager's
  // view. Without this guard a locally-cancelled job (driver has no cancelJob —
  // FDM Monster) was resurrected by its next poll: cancelled → printing → later a
  // spurious print.completed + filament deduction. Local terminal is final.
  if (TERMINAL.has(job.status)) return { status: job.status, terminal: true, intervalMs: 0 };
  const conn = await platform().devices.connections().getInternal(orgId, job.connection_id);
  const { intervalMs, fast } = pollTuning(conn ?? null);
  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return null;

  // F-12: a single transient poll error must NOT flip a live print to a
  // permanent `failed` (which fires the failure wires + frees the printer). A
  // dropped packet is not a failed print. Only declare terminal failure after
  // POLL_ERROR_THRESHOLD consecutive errors; a successful poll resets the count.
  let status: string;
  let progress: number | null = null;
  let error: string | null = null;
  let etaSec: number | null = null;
  let elapsedSec: number | null = null;
  const manager = await managerName(orgId, job.connection_id);
  try {
    const st = await driver.getJobStatus(job.remote_job_id);
    if(job.cnc_setup) await persistCncRuntime(db,jobId,st.raw&&typeof st.raw==="object"?(st.raw as Record<string,unknown>).toolSeconds:undefined);
    progress = st.progress ?? null;
    etaSec = st.timeRemainingSec ?? null;
    elapsedSec = st.elapsedSec ?? null;
    // What the report means for THIS job (see job-truth.ts): an idle printer
    // is not a finished print unless the job was seen printing and got to the
    // end, and a cancel asked for from Cobblr is final only when the printer
    // confirms it.
    const truth = interpretReport({
      reported: st.state,
      progress,
      prevStatus: job.status,
      cancelRequested: job.cancel_requested_at != null,
      sentAt: job.sent_at ?? null,
      now: new Date(),
    });
    status = truth.status;
    error = truth.note;
    if(job.cnc_setup && (status === "paused"||st.state === "unknown") && !job.cancel_requested_at) error=st.message?.trim().slice(0,300)||"Paused at the CNC controller.";
    if (status === "failed" && !error) {
      const said = st.message?.trim();
      error = said ? `${manager} reported: ${said.slice(0, 240)}` : `${manager} reported an error and didn't say which.`;
    }
  } catch (e) {
    const errs = (job.poll_errors ?? 0) + 1;
    const now = new Date();
    const since = job.unreachable_since ?? now;
    const plan = unreachablePlan({ since, now, misses: errs, fast });
    error = `${plainDriverError(e, manager, "checking on the print")} ${plan.note}`.slice(0, 300);
    if (!plan.giveUp) {
      // Out of reach is not a failed print: keep the job's status, say so,
      // and ask again later, backing off while it stays out of reach.
      await db
        .updateTable("digifab_jobs")
        .set({ error, poll_errors: errs, unreachable_since: since, last_polled_at: now, updated_at: now })
        .where("id", "=", jobId)
        .execute();
      return { status: job.status, terminal: false, intervalMs: plan.nextPollMs };
    }
    status = "failed";
  }

  // Reprint-on-fail — a failed print with attempts left goes BACK to the queue
  // instead of going terminal (no failed event). The failed print very likely
  // left debris on the bed, so the retry does NOT bypass the F-1 bed-clear gate:
  // the device gets its attention row NOW, and the retry proceeds only once a
  // human clears the bed (pool jobs re-drip via the assign worker's attention
  // check; device-targeted jobs are auto-resent by the fleet `ready` route).
  // Out of attempts → fall through to the terminal path below.
  if (status === "failed") {
    const att = (job.attempts ?? 0) + 1;
    const max = job.cnc_setup ? 1 : job.max_attempts ?? 1;
    if (att < max) {
      const note = `auto-retry ${att}/${max} waiting for bed clear: ${error ?? "failed"}`.slice(0, 300);
      const base = { status: "queued", attempts: att, remote_job_id: null, remote_file_id: null, progress: 0, error: note, poll_errors: 0, unreachable_since: null, last_polled_at: new Date(), updated_at: new Date() };
      if (job.connection_id && job.target_device) {
        await db
          .insertInto("digifab_device_attention")
          .values({ connection_id: job.connection_id, remote_device_id: job.target_device, job_id: jobId, reason: "print-failed" })
          .onConflict((oc) =>
            oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ job_id: jobId, reason: "print-failed", created_at: new Date() }),
          )
          .execute();
      }
      if (job.target_pool) {
        await db.updateTable("digifab_jobs").set({ ...base, connection_id: null, target_device: null }).where("id", "=", jobId).execute();
        await kickAssign(orgId);
      } else {
        await db.updateTable("digifab_jobs").set(base).where("id", "=", jobId).execute();
      }
      // NOT terminal, but the send path owns any new poll chain — returning
      // terminal:true here stops THIS chain so a resend can't end up with two
      // self-re-enqueuing pollers on one job (they double manager load and race
      // the milestone notifications).
      return { status: "queued", terminal: true, intervalMs };
    }
  }

  const terminal = TERMINAL.has(status);
  const fields = { progress, error, eta_sec: etaSec != null ? Math.round(etaSec) : null, poll_errors: 0, unreachable_since: null, last_polled_at: new Date() };
  if (terminal) {
    // Status flip + bed-clear row, one transaction — see markJobTerminal. A
    // concurrent poll that already ended the job wins; this one emits nothing,
    // so a finish is announced, and a spool charged, exactly once.
    const claimed = await markJobTerminal(db, job as never, status as "completed" | "failed" | "cancelled", fields);
    if (!claimed) {
      const now = await db.selectFrom("digifab_jobs").select("status").where("id", "=", jobId).executeTakeFirst();
      return { status: now?.status ?? status, terminal: true, intervalMs };
    }
  } else {
    const updated=await db
      .updateTable("digifab_jobs")
      .set({ status, ...fields, updated_at: new Date() })
      .where("id", "=", jobId)
      .where("status", "not in", [...TERMINAL])
      .executeTakeFirst();
    if(Number(updated.numUpdatedRows??0)===0){
      const current=await db.selectFrom("digifab_jobs").select("status").where("id","=",jobId).executeTakeFirst();
      return {status:current?.status??status,terminal:TERMINAL.has(current?.status??status),intervalMs:0};
    }
  }

  // ── Print-lifecycle notifications (the "post updates to Discord" flow) ──
  // A 25/50/75% milestone fires once as it's crossed (the stored progress is the
  // "last seen", so the next poll in the same bucket won't re-notify).
  const gramsUsed = job.material_grams != null ? Number(job.material_grams) : null;
  if (!terminal && status === "printing") {
    const newB = progressBucket(progress);
    if (newB > progressBucket(job.progress != null ? Number(job.progress) : null) && newB >= 1 && newB <= 3) {
      const cam = await cameraFor(db, job.connection_id, job.target_device);
      void notifyPrint(orgId, { kind: "progress", jobId, fileRef: job.file_ref, device: job.target_device, cameraUrl: cam, progress, etaSec, elapsedSec, gramsUsed });
    }
  }

  if (terminal) {
    const largePrint = !!await db.selectFrom("digifab_large_prints").select("job_id").where("job_id", "=", jobId).executeTakeFirst();
    const cutterJob = largePrint || !!await db.selectFrom("digifab_cutter_plans").select("id").where("job_id", "=", jobId).executeTakeFirst();
    // (F-1 bed-clear `needs_attention` was already written atomically with the
    // status flip above — see the transaction — so an assign pass can never see
    // the freed bed without the attention row.)
    // The marquee reactivity hook: a default wire can carry
    // print.completed → projects:set-dep-satisfied / mark task done /
    // bump stock, with neither module importing the other.
    // Surface the consumed filament as { partId, delta } so a seeded
    // digifab.print.completed → inventory.adjust-stock wire deducts it (the
    // adjust-stock handler reads partId/delta straight off the payload). Only
    // on a clean completion — a failed print didn't consume the spool.
    const grams = job.material_grams != null ? Number(job.material_grams) : null;
    const material =
      status === "completed" && driver.printProcess !== "resin" && job.material_part_id && grams && grams > 0
        ? {
            partId: job.material_part_id,
            delta: -grams,
            // In grams: the wire converts to the spool's own unit (kg).
            unit: "g",
            once: true,
            reason: `Print: ${job.file_ref}`,
            // Source attribution for the consumption ledger — "this print drew it down".
            sourceKind: "digifab:job",
            sourceId: jobId,
          }
        : {};
    // No spool picked on the job: the spools loaded on its printer pay, each
    // for its own slot's grams.
    if (status === "completed" && !cutterJob && driver.printProcess !== "resin") {
      await drawForCompletedJob(db, orgId, job as never).catch((err: unknown) =>
        console.error(`[digifab] job ${jobId}: drawing from the loaded spools failed: ${(err as Error).message}`),
      );
    }
    // A driver-reported `cancelled` (someone stopped it at the printer) is NOT a
    // failure — firing print.failed for it ran failure wires + posted "❌ Print
    // failed" for a deliberate stop. Cancelled emits nothing; completed/failed
    // emit their events as before.
    if (status !== "cancelled") {
      void platform().events.emit(
        status === "completed" ? "digifab.print.completed" : "digifab.print.failed",
        {
          orgId,
          jobId,
          connectionId: job.connection_id,
          linkedMachineId: job.linked_machine_id,
          linkedTaskId: job.linked_task_id,
          ...material,
        },
      );
    }
    // The Make this job printed catches up: its Print step's state and the
    // spools it drew from.
    await settleMakeForJob(db, orgId, jobId, status as "completed" | "failed" | "cancelled");
    // A failed print is scrap: nothing it made counts, and its build is
    // reversed. A cancel made nothing and is not scrap; its commit is undone.
    // A completion is judged at the bed-clear verdict; one with no bed to clear
    // (no device on the job) has no verdict coming, so it counts as made now.
    if (status === "failed" && !cutterJob) {
      await recordJobOutcome(db, orgId, jobId, "scrap", "print-failed");
    } else if (status === "cancelled") {
      await reverseBuildIfCommitted(db, orgId, jobId, "print cancelled");
    } else if (!cutterJob && !needsBedClear(job as never)) {
      await recordJobOutcome(db, orgId, jobId, "good", "auto");
    }
    // Discord/in-app update on the terminal outcome.
    const cam = await cameraFor(db, job.connection_id, job.target_device);
    void notifyPrint(orgId, {
      kind: status === "completed" ? "completed" : "failed",
      jobId,
      fileRef: job.file_ref,
      device: job.target_device,
      cameraUrl: cam,
      progress,
      elapsedSec,
      gramsUsed,
      error: status === "cancelled" ? (error ?? "cancelled at the printer") : error,
    });
    // A freed printer should immediately pull the next queued pool job, rather
    // than wait for the worker's next re-tick. Dynamic import avoids a static
    // cycle (assign-worker imports this file).
    void import("./assign-worker.js").then((m) => m.kickAssign(orgId)).catch(() => {});
  }
  return { status, terminal, intervalMs };
}

/** Queue commits the materials. When a just-placed job (status "sent") produces
 *  a build (BoM) and hasn't been consumed yet, fire `digifab.job.build_committed`
 *  ONCE — a seeded builds wire deducts the components from inventory. The output
 *  part is NOT credited here: parts count as made when the plate is judged good
 *  (recordJobOutcome), so a print that fails never adds stock (#4050). The
 *  build_consumed_at guard (set atomically here) makes a re-send / recut
 *  idempotent. Best-effort: a failure never blocks the send. */
async function commitBuildIfLinked(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  job: { linked_build_id: string | null; build_consumed_at: Date | null; build_qty: number | null },
  status: string,
): Promise<void> {
  if (status !== "sent" || !job.linked_build_id || job.build_consumed_at) return;
  // A dangling build id (deleted since job creation, or the builds module is
  // off) must not be SILENTLY stamped consumed — the wire would no-op and the
  // job would forever claim it drew inventory it never touched. Surface it on
  // the job instead and leave build_consumed_at null.
  const build = await platform().entities.lookup(orgId, "builds:build", job.linked_build_id).catch(() => null);
  if (!build) {
    await db
      .updateTable("digifab_jobs")
      .set({ error: "linked build not found: no inventory was consumed", updated_at: new Date() })
      .where("id", "=", jobId)
      .execute();
    return;
  }
  const res = await db
    .updateTable("digifab_jobs")
    .set({ build_consumed_at: new Date(), build_output_deferred: true })
    .where("id", "=", jobId)
    .where("build_consumed_at", "is", null)
    .executeTakeFirst();
  // Only the writer that flipped null→now emits, so concurrent sends can't
  // double-consume even if they raced past the in-memory guard above.
  if (Number(res.numUpdatedRows ?? 0n) === 0) return;
  // AWAITED, not fire-and-forget. The wire that moves the stock is the commit;
  // a cancel that follows the send reverses it, and the two ran concurrently
  // when this was `void`: under a contended runner the reversal's output
  // decrement landed before the commit's output credit, on a record still at
  // 0, where the stock floor refuses it, and the credit then stood with
  // nothing left to reverse it (#2826, phantom output on cancel). emit never
  // rejects, so a failing wire still never blocks the send; the send just
  // returns after the stock has moved, which is the platform's own rule for
  // read-after-write (events.ts).
  await platform().events.emit("digifab.job.build_committed", {
    orgId,
    jobId,
    buildId: job.linked_build_id,
    qty: job.build_qty != null ? Number(job.build_qty) : 1,
    // builds:build-one consumes the components and leaves the output for
    // digifab.job.build_output, fired by the good verdict.
    outputOnGood: true,
  });
}

/** The reversal twin of commitBuildIfLinked. A job whose build was committed at
 *  send but that then failed / was cancelled / was scrapped at the bed-clear
 *  verdict never produced its output — emit `digifab.job.build_reversed` ONCE
 *  (a seeded builds wire puts the components back and removes the output credit).
 *  Same null→now atomic flip (`build_reversed_at`) so cancel + scrap + fail can
 *  all call this and only the first reverses. Exported for the cancel route and
 *  the bed-clear verdict route. */
export async function reverseBuildIfCommitted(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  reason: string,
): Promise<boolean> {
  const job = await db
    .selectFrom("digifab_jobs")
    .select(["linked_build_id", "build_qty", "build_consumed_at", "build_reversed_at", "build_output_deferred", "build_output_at"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job?.linked_build_id || !job.build_consumed_at || job.build_reversed_at) return false;
  const res = await db
    .updateTable("digifab_jobs")
    .set({ build_reversed_at: new Date() })
    .where("id", "=", jobId)
    .where("build_reversed_at", "is", null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows ?? 0n) === 0) return false;
  // Awaited for the same reason as the commit: a reversal is not done until
  // the stock is back, and whoever asked (the cancel route, the verdict) may
  // be re-read the moment it answers.
  await platform().events.emit("digifab.job.build_reversed", {
    orgId,
    jobId,
    buildId: job.linked_build_id,
    qty: job.build_qty != null ? Number(job.build_qty) : 1,
    reason,
    // Take back an output credit only when one was given: at send on a job
    // committed before #4050, or by a good verdict. A deferred output that was
    // never credited has nothing to take back.
    outputCredited: !job.build_output_deferred || !!job.build_output_at,
  });
  return true;
}

export type JobOutcome = "good" | "scrap";
export type JobOutcomeSource = "bed-clear" | "print-failed" | "auto";
export type JobOutcomeRecorded = { recorded: true; outcome: JobOutcome; goodQty: number; scrapQty: number } | { recorded: false };

/**
 * THE ONE PLACE A JOB'S OUTCOME IS WRITTEN: how many came off the plate good
 * and how many were scrap. Parts count as made here and nowhere else (#4050):
 * a good count credits the build's output (digifab.job.build_output → the
 * seeded builds:credit-output wire); a whole-plate scrap reverses the build;
 * a partial scrap leaves the components consumed, because they were used and
 * lost. Written once (outcome_at null→now), so a second verdict never counts
 * twice. Emits digifab.job.outcome for every judged job, build or not, which
 * is what a work order's yield reads.
 *
 * `counts` are in builds (the job's build_qty unit). Without them the verdict
 * covers the whole plate.
 */
export async function recordJobOutcome(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  outcome: JobOutcome,
  source: JobOutcomeSource,
  counts?: { good: number; scrap: number },
): Promise<JobOutcomeRecorded> {
  const job = await db
    .selectFrom("digifab_jobs")
    .select(["id", "run_id", "linked_build_id", "build_qty", "build_consumed_at", "build_reversed_at", "build_output_deferred", "outcome_at", "resin_print", "embroidery_run"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job) return { recorded: false };
  if (job.embroidery_run) {
    const run = await db.selectFrom("digifab_embroidery_runs").select(["stock_recorded_at", "report"]).where("job_id", "=", jobId).executeTakeFirst();
    if (!run?.stock_recorded_at || run.report?.verdict !== outcome) throw new ReviewRequired("Record the measured thread use and original verdict at the embroidery station first.");
  }
  const whole = Math.max(1, Number(job.build_qty ?? 1) || 1);
  const clean = (n: number) => Math.max(0, Math.floor(Number(n) || 0));
  const good = counts ? clean(counts.good) : outcome === "good" ? whole : 0;
  const scrap = counts ? clean(counts.scrap) : outcome === "good" ? 0 : whole;
  const settled: JobOutcome = good > 0 ? "good" : "scrap";
  if (job.resin_print) await settleResinPrint(db, orgId, jobId, settled, null);
  const large = await db.selectFrom("digifab_large_prints").select("consumed_at").where("job_id", "=", jobId).executeTakeFirst();
  if (large && !large.consumed_at) throw new ReviewRequired("Record roll and ink use at this printer before clearing the job.");
  if (job.outcome_at) return { recorded: false };

  const claim = await db
    .updateTable("digifab_jobs")
    .set({
      outcome: settled,
      outcome_good_qty: good,
      outcome_scrap_qty: scrap,
      outcome_at: new Date(),
      outcome_source: source,
      updated_at: new Date(),
    })
    .where("id", "=", jobId)
    .where("outcome_at", "is", null)
    .executeTakeFirst();
  if (Number(claim.numUpdatedRows ?? 0n) === 0) return { recorded: false };

  const committed = !!job.linked_build_id && !!job.build_consumed_at && !job.build_reversed_at;
  if (committed && job.build_output_deferred && good > 0) {
    const credit = await db
      .updateTable("digifab_jobs")
      .set({ build_output_at: new Date() })
      .where("id", "=", jobId)
      .where("build_output_at", "is", null)
      .executeTakeFirst();
    // Awaited: whoever gave the verdict re-reads stock the moment it answers.
    if (Number(credit.numUpdatedRows ?? 0n) > 0) {
      await platform().events.emit("digifab.job.build_output", {
        orgId,
        jobId,
        buildId: job.linked_build_id,
        qty: good,
      });
    }
  }
  if (committed && good === 0) {
    await reverseBuildIfCommitted(db, orgId, jobId, source === "print-failed" ? "print failed" : "print scrapped");
  }

  await platform().events.emit("digifab.job.outcome", {
    orgId,
    jobId,
    runId: job.run_id,
    buildId: job.linked_build_id,
    outcome: settled,
    goodQty: good,
    scrapQty: scrap,
    source,
  });
  return { recorded: true, outcome: settled, goodQty: good, scrapQty: scrap };
}

export type SendJobResult =
  | { ok: true; status: string; remoteJobId: string | null; placement: SubmitResult; uploadedBytes: number; shouldPoll: boolean }
  | { ok: false; code: "not_found" | "already_sent" | "already_sending" | "already_terminal" | "no_connection" | "unknown_device" | "file_missing" | "review_required" | "batch_approval_required" }
  /** The manager refused or could not be reached: the job is failed with this
   *  sentence on it, and the sentence is what the person sees. */
  | { ok: false; code: "send_failed" | "material_not_ready"; message: string; shouldPoll?: boolean };

/** Claim a job for ONE send, in a single conditional UPDATE: the job still
 *  unsent, in one of `statuses`, and not already claimed. Two sends of one job
 *  at once (a double tap, a retry, an assistant and a person, two tabs) both
 *  pass a read-then-check; only one wins this. Returns the claim's token, or
 *  null when another send holds the job. Only the winner talks to the printer. */
export async function claimSend(db: Kysely<DigifabDB>, jobId: string, statuses: readonly string[]): Promise<string | null> {
  const token = randomUUID();
  const r = await db
    .updateTable("digifab_jobs")
    .set({ send_token: token, send_claimed_at: new Date() })
    .where("id", "=", jobId)
    .where("remote_job_id", "is", null)
    .where("status", "in", [...statuses])
    .where("send_token", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0n) > 0 ? token : null;
}

/** Give a claim back when the send stops before the printer was asked anything. */
async function releaseSend(db: Kysely<DigifabDB>, jobId: string, token: string): Promise<void> {
  await db.updateTable("digifab_jobs").set({ send_token: null, send_claimed_at: null }).where("id", "=", jobId).where("send_token", "=", token).execute();
}

const SENDABLE = ["queued", "assigning", "sent", "awaiting-assignment", "printing", "paused"] as const;

/** Upload + place a job on its connection's farm. Pure (no express, no poll
 *  enqueue) so the send ROUTE and the assignment WORKER share it — the caller
 *  enqueues the poll when `shouldPoll`. Mirrors the original /jobs/:id/send body.
 *  The job must already carry a connection (an unassigned pool job is assigned
 *  first, then sent). */
export async function sendJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  approval?: JobApproval,
  batchPermit?: BatchStartPermit,
): Promise<SendJobResult> {
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job) return { ok: false, code: "not_found" };
  if (job.make_ordinal && !takeBatchStartPermit(batchPermit, job.id)) return { ok: false, code: "batch_approval_required" };
  if (job.embroidery_run) return { ok: false, code: "review_required" };
  if (job.remote_job_id) return { ok: false, code: "already_sent" };
  // A finished/cancelled job can't be quietly re-sent (a cancelled-before-send or
  // assign-failed job has no remote_job_id, so the guard above alone let a
  // terminal job flip straight back to `sent`). Retry is an explicit endpoint.
  if (TERMINAL.has(job.status)) return { ok: false, code: "already_terminal" };
  if (!job.connection_id) return { ok: false, code: "no_connection" };

  // From here on this send owns the job, or it stops: nothing below this line
  // runs twice for one job at the same time.
  const token = await claimSend(db, jobId, SENDABLE);
  if (!token) return { ok: false, code: "already_sending" };
  let r: SendJobResult = { ok: false, code: "already_sending" };
  try {
    const driver = await buildDriverById(db, orgId, job.connection_id);
    if (await driver?.jobReviewRequired?.()) {
      const run = await platform().exclusive.run(`laser-start:${orgId}:${job.connection_id}:${job.target_device}`, async () => { r = await sendClaimed(db, orgId, jobId, job, token, approval); });
      if (!run.ran) r = { ok: false, code: "already_sending" };
    } else r = await sendClaimed(db, orgId, jobId, job, token, approval);
    return r;
  } catch (error) {
    const message = plainDriverError(error, await managerName(orgId, job.connection_id), "preparing the job").slice(0, 300);
    await db.updateTable("digifab_jobs").set({ error: message, updated_at: new Date() }).where("id", "=", jobId).execute();
    return { ok: false, code: "send_failed", message };
  } finally {
    await releaseSend(db, jobId, token);
  }
}

async function sendClaimed(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  job: Selectable<DigifabDB["digifab_jobs"]>,
  token: string,
  approval?: JobApproval,
): Promise<SendJobResult> {
  const connectionId = job.connection_id!;
  const driver = await buildDriverById(db, orgId, connectionId);
  if (!driver) return { ok: false, code: "no_connection" };

  // A job linked to a machine (and not otherwise targeted) routes to that
  // machine's mapped device.
  let deviceId = job.target_device;
  if (!deviceId && !job.target_tag && job.linked_machine_id) {
    const link = await db
      .selectFrom("digifab_device_links")
      .select(["remote_device_id"])
      .where("connection_id", "=", connectionId)
      .where("machine_id", "=", job.linked_machine_id)
      .executeTakeFirst();
    if (link) deviceId = link.remote_device_id;
  }

  // F-6/F-7 — resolve and validate the target against THIS connection's real
  // printer list, on our side, before we upload or submit. A remote device id
  // is only unique within its manager, and not every driver honours the `tag`
  // param (FDM Monster's classic submit ignores it) — so doing it here makes
  // every driver behave identically and stops a stale/cross-connection id from
  // silently landing a print on the wrong machine. listDevices is read-only;
  // if it can't be reached we fall through (submitJob will surface its own
  // error) rather than block a send on a transient list hiccup.
  if (deviceId || job.target_tag) {
    let devices: RemoteDevice[] = [];
    try {
      devices = await driver.listDevices();
    } catch {
      devices = [];
    }
    if (devices.length > 0) {
      if (deviceId && !devices.some((d) => d.id === deviceId)) {
        // F-7: an explicit target that this connection doesn't have — refuse
        // rather than blind-submit a print to whatever id the manager maps it to.
        return { ok: false, code: "unknown_device" };
      }
      if (!deviceId && job.target_tag) {
        // F-6: resolve the tag to a concrete printer ourselves. Prefer an
        // enabled, assignable (idle) one; else any tagged printer (the manager
        // queues it). No match → leave deviceId null so the submit routes/awaits
        // visibly instead of dropping the tag on the floor.
        const tag = job.target_tag;
        const tagged = devices.filter((d) => (d.tags ?? []).includes(tag));
        const pick = tagged.find((d) => d.enabled && isAssignable(d.state ?? "")) ?? tagged[0];
        if (pick) deviceId = pick.id;
      }
    }
  }

  // Real bytes when the job references a stored file (via the platform seam —
  // no core-files import); else the placeholder path where file_ref is a routing
  // string. uploadName drives the farm-side filename (+ the mock's routing).
  let fileBytes = new Uint8Array();
  let uploadName = job.file_ref;
  if (job.file_id) {
    const f = await platform().files.read(orgId, job.file_id);
    if (!f) {
      // The stored file was deleted since the job was created. Refuse rather
      // than silently upload a ZERO-BYTE gcode to a real farm.
      await db
        .updateTable("digifab_jobs")
        .set({ error: "the job's stored file no longer exists, re-create the job with a file", updated_at: new Date() })
        .where("id", "=", jobId)
        .execute();
      return { ok: false, code: "file_missing" };
    }
    fileBytes = new Uint8Array(f.bytes);
    uploadName = f.filename;
  }

  if (!job.resin_print && driver.printProcess !== "resin" && !driver.laserBackend && !job.laser_layout) {
    const refusal = await checkJobMaterial(db, orgId, job, deviceId, uploadName, fileBytes);
    if (refusal) return { ok: false, code: "material_not_ready", message: refusal };
  }

  // HYBRID Bambu LAN: the cloud can't accept an arbitrary file, but the on-site
  // bridge can push it over the printer's LAN. If this Bambu printer has LAN
  // configured, route the upload + submit through the bridge's `bambu` driver
  // (cloud `driver` is still used above for listDevices/validation).
  let sendDriver = driver;
  if (deviceId) {
    const lan = await bambuLanDriverFor(orgId, connectionId, deviceId);
    if (lan) sendDriver = lan;
  }

  // A manager that refuses, times out or cannot be reached ends the send
  // here with a sentence on the job. It used to throw out through the route
  // as a raw 500 carrying the manager's URL and JSON body, and the job itself
  // stayed queued with nothing on it saying anything had gone wrong.
  let up: Awaited<ReturnType<MachineDriver["uploadFile"]>>;
  let sub: SubmitResult;
  let doing = "uploading the file";
  let cutter = false;
  let cnc = false;
  let resinAccepted = false;
  let largeMayHaveStarted = false;
  let resinChecks = 0;
  try {
    doing = "preparing and starting the job";
    const reviewRequired = await sendDriver.jobReviewRequired?.();
    const kind = reviewRequired ? await sendDriver.jobReviewKind?.() : undefined;
    const plannedCut = await db.selectFrom("digifab_cutter_plans").select("id").where("job_id", "=", jobId).executeTakeFirst();
    if (plannedCut && kind !== "cutter") throw new ReviewRequired("This prepared cut needs its original cutter driver. Restore that connection before Start.");
    const plannedPrint = await db.selectFrom("digifab_large_prints").select("job_id").where("job_id", "=", jobId).executeTakeFirst();
    if (!!plannedPrint !== (sendDriver.printProcess === "large-format")) throw new ReviewRequired("Prepare this document for its original large-format printer.");
    const printReview = approval && (kind === "print" || kind === "cnc") ? await sendDriver.getJobReview?.(approval.fileId) : undefined;
    cnc = kind === "cnc";
    if (cnc && printReview?.project.kind !== "cnc") throw new ReviewRequired("Review this posted program at its CNC station before Start.");
    cutter = kind === "cutter";
    const stationPermit = reviewRequired ? cutter ? await authorizeCutterStart(db, orgId, { ...job, target_device: deviceId }, approval) : await authorizeLaserStart(db, orgId, { ...job, target_device: deviceId }, approval, printReview) : undefined;
    if (sendDriver.printProcess === "resin") {
      if (!approval) throw new ReviewRequired("Review this resin print at its station before Start.");
      await reserveResinPrint(db, orgId, jobId, approval.fileId);
    }
    const layout = job.laser_layout;
    if (layout && approval && sendDriver.getJobReview) {
      try { const review = await sendDriver.getJobReview(approval.fileId); verifyLaserOutput(layout.expected, review); if (review.contentHash !== layout.content_hash) throw new Error("The queued layout file changed. Make a new plan."); } catch (e) { throw new ReviewRequired(e instanceof Error ? e.message : "The generated settings changed."); }
    }
    let cutterMayHaveStarted = false;
    const checkStartAllowed = sendDriver.laserBackend || cnc || cutter || ["resin", "large-format"].includes(sendDriver.printProcess ?? "") ? async () => {
      if (sendDriver.printProcess === "resin" && resinChecks++ > 0) {
        resinAccepted = true;
        await setResinPhase(db, jobId, "started");
      }
      const current = await db.selectFrom("digifab_jobs").select(["cancel_requested_at", "status"]).where("id", "=", jobId).executeTakeFirst();
      if (!current || current.cancel_requested_at || TERMINAL.has(current.status)) throw new ReviewRequired("Stop was requested. Review this job again before Start.");
      if (cnc && approval && printReview) {
        const station = await db.selectFrom("digifab_stations").select("id").where("token_hash", "=", stationTokenHash(approval.stationToken ?? "")).where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId!).where("revoked_at", "is", null).executeTakeFirst();
        if (!station) throw new ReviewRequired("This screen's Start permission was revoked. Stop and authorize the machine station again.");
        await validateCncStock(orgId, { ...job, target_device: deviceId }, approval, printReview, station.id);
      }
      if (sendDriver.printProcess === "large-format" && deviceId) {
        await authorizeLaserStart(db, orgId, { ...job, target_device: deviceId }, approval, printReview);
        await verifyLargePrint(db, orgId, jobId, connectionId, deviceId, largeMayHaveStarted);
        if (!largeMayHaveStarted) {
          await db.updateTable("digifab_large_prints").set({started_at:new Date()}).where("job_id","=",jobId).where("started_at","is",null).execute();
          largeMayHaveStarted=true;
        }
      }
      if (cutter && deviceId) {
        await requireCutterStation(db, connectionId, deviceId, approval?.stationToken);
        await verifyCutterPlan(db, orgId, jobId, connectionId, deviceId, true, cutterMayHaveStarted);
        if (!cutterMayHaveStarted) {
          await db.updateTable("digifab_cutter_plans").set({ started_at: new Date() }).where("job_id", "=", jobId).where("started_at", "is", null).execute();
          cutterMayHaveStarted = true;
        }
      }
      if (sendDriver.printProcess === "resin") {
        await authorizeLaserStart(db, orgId, { ...job, target_device: deviceId }, approval, printReview);
        await checkResinStart(db, orgId, jobId);
      }
    } : undefined;
    ({ up, sub } = await submitReviewedJob(sendDriver, fileBytes, uploadName, { deviceId, tag: job.target_tag, idempotencyKey: token, approval, checkStartAllowed }, stationPermit));
  } catch (e) {
    if(e instanceof InterruptedStart){
      await db.updateTable("digifab_jobs").set({remote_file_id:approval?.fileId??null,remote_job_id:e.remoteJobId,status:"sent",sent_at:new Date(),cancel_requested_at:new Date(),send_token:null,send_claimed_at:null,error:e.message,updated_at:new Date()}).where("id","=",jobId).execute();
      return {ok:false,code:"send_failed",message:e.message,shouldPoll:true};
    }
    if (cnc) await releaseUnstartedCncStock(db, jobId);
    if (sendDriver.printProcess === "resin") {
      if (resinAccepted && approval) {
        const remote = `cobblr-${approval.fileId}.goo`;
        await db.updateTable("digifab_jobs").set({ remote_job_id: remote, sent_at: new Date(), cancel_requested_at: new Date(), updated_at: new Date() }).where("id", "=", jobId).execute();
        await enqueuePoll(orgId, jobId);
      } else await setResinPhase(db, jobId, "released");
    }
    if (e instanceof ReviewRequired && !largeMayHaveStarted) return { ok: false, code: "send_failed", message: e.message };
    const message = plainDriverError(e, await managerName(orgId, connectionId), doing).slice(0, 300);
    await markJobTerminal(db, job, "failed", { error: message });
    return { ok: false, code: "send_failed", message };
  }
  const status = sub.queued ? "sent" : "awaiting-assignment";
  // Normalize a driver's ""/undefined job id to null, and make the dead end LOUD:
  // a queued job with no remote id can never be polled — it would sit in `sent`
  // forever with nothing on the row saying why. Surface it so the user knows to
  // track it at the manager (manual poll can't help either).
  const remoteJobId = sub.jobId ? String(sub.jobId) : null;
  const untrackable = sub.queued && !remoteJobId;
  const sentFields = {
      ...(sub.interrupted ? {cancel_requested_at: new Date()} : {}),
      remote_file_id: up.fileId,
      remote_job_id: remoteJobId,
      target_device: sub.deviceId ?? deviceId,
      status,
      sent_at: new Date(),
      ...(sendDriver.laserBackend || cnc || cutter || ["resin", "large-format"].includes(sendDriver.printProcess ?? "") ? {} : { cancel_requested_at: null }),
      send_token: null,
      send_claimed_at: null,
      // A note from before the send (a stopped send, a retry waiting on the
      // bed) no longer describes the job once it is on a printer.
      error: untrackable ? "the manager accepted the job but returned no job id. Cobblr can't track it to completion" : null,
      poll_errors: 0,
      unreachable_since: null,
      updated_at: new Date(),
    };
  if (sendDriver.printProcess === "resin") {
    await setResinPhase(db, jobId, "started");
    if (!deviceId || !await persistResinStart(db, sendDriver, deviceId, jobId, token, sentFields)) {
      if (remoteJobId) await enqueuePoll(orgId, jobId);
      return { ok: false, code: "send_failed", message: "Stop was requested. Waiting for the printer to confirm it stopped." };
    }
  } else if (sendDriver.printProcess === "large-format") {
    if (!deviceId || !await persistResinStart(db, sendDriver, deviceId, jobId, token, sentFields)) {
      if (remoteJobId) await enqueuePoll(orgId, jobId);
      return {ok:false,code:"send_failed",message:"Stop was requested. Waiting for the printer to confirm it stopped."};
    }
  } else await db.updateTable("digifab_jobs").set(sentFields).where("id", "=", jobId).execute();
  if (cutter) await db.updateTable("digifab_cutter_plans").set({ started_at: new Date() }).where("job_id", "=", jobId).execute();
  void platform().events.emit("digifab.job.sent", { orgId, jobId, status });
  await commitBuildIfLinked(db, orgId, jobId, job, status);
  if (sub.queued) {
    const placed = sub.deviceId ?? deviceId;
    const cam = await cameraFor(db, job.connection_id, placed);
    void notifyPrint(orgId, { kind: "started", jobId, fileRef: job.file_ref, device: placed, cameraUrl: cam, gramsUsed: job.material_grams != null ? Number(job.material_grams) : null });
  }
  return {
    ok: true,
    status,
    remoteJobId,
    placement: sub,
    uploadedBytes: fileBytes.byteLength,
    shouldPoll: !!(sub.queued && remoteJobId),
  };
}

async function checkJobMaterial(
  db: Kysely<DigifabDB>, orgId: string, job: Selectable<DigifabDB["digifab_jobs"]>,
  deviceId: string | null, filename: string, bytes?: Uint8Array,
): Promise<string | null> {
  const machine = await machineOfJob(db, { ...job, target_device: deviceId });
  if (!machine) return null;
  const metadata = bytes ? extractPlateMetadata(filename, Buffer.from(bytes)) : {};
  const requirements = {
    ...job,
    material_type: metadata.material ?? job.material_type,
    material_grams: metadata.filament_g ?? job.material_grams,
    material_grams_by_tool: metadata.filament_g_by_tool ?? job.material_grams_by_tool,
    material_by_tool: metadata.material_by_tool,
    color_by_tool: metadata.color_by_tool,
  };
  if (printerMaterialRefusal(requirements, []) === null) return null;
  const { loadedSpoolsForMachine } = await import("./api/printing-profiles.js");
  const refusal = printerMaterialRefusal(requirements, await loadedSpoolsForMachine(orgId, machine));
  const fields = {
    material_type: requirements.material_type,
    material_grams: requirements.material_grams == null ? null : String(requirements.material_grams),
    material_grams_by_tool: requirements.material_grams_by_tool,
  };
  Object.assign(job, fields);
  await db.updateTable("digifab_jobs").set({ ...fields, material_grams_by_tool: fields.material_grams_by_tool == null ? null : JSON.stringify(fields.material_grams_by_tool), ...(refusal ? { error: refusal } : {}), updated_at: new Date() }).where("id", "=", job.id).execute();
  return refusal;
}

export type AssignJobResult =
  | { ok: true; status: string; remoteJobId: string | null; placement: SubmitResult; shouldPoll: boolean }
  | { ok: false; code: "not_found" | "batch_approval_required" | "not_awaiting" | "no_connection" | "no_file" | "unknown_device" | "already_sending" }
  | { ok: false; code: "material_not_ready"; message: string };

/** F-14 — re-pick a printer for a job stuck in `awaiting-assignment` (its target
 *  matched 0 or many printers). The file is ALREADY on the farm (remote_file_id),
 *  so this just re-submits it to a now-explicit device — no re-upload, no
 *  delete-and-recreate. Validates the device belongs to the connection (F-7).
 *  The send route can't do this: it refuses a job that's already been placed. */
export async function assignJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  deviceId: string,
): Promise<AssignJobResult> {
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job) return { ok: false, code: "not_found" };
  if (job.make_ordinal) return { ok: false, code: "batch_approval_required" };
  if (job.status !== "awaiting-assignment") return { ok: false, code: "not_awaiting" };
  if (!job.connection_id) return { ok: false, code: "no_connection" };
  if (!job.remote_file_id) return { ok: false, code: "no_file" };

  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return { ok: false, code: "no_connection" };

  // F-7: the chosen device must actually be on this connection.
  let devices: RemoteDevice[] = [];
  try {
    devices = await driver.listDevices();
  } catch {
    devices = [];
  }
  if (devices.length > 0 && !devices.some((d) => d.id === deviceId)) {
    return { ok: false, code: "unknown_device" };
  }

  // The same one-send claim as sendJob: two re-picks of one job at once would
  // otherwise both submit it.
  const token = await claimSend(db, jobId, ["awaiting-assignment"]);
  if (!token) return { ok: false, code: "already_sending" };
  let sub: SubmitResult;
  try {
    if (driver.printProcess !== "resin" && !driver.laserBackend && !job.resin_print && !job.laser_layout) {
      const file = job.file_id ? await platform().files.read(orgId, job.file_id) : null;
      const refusal = await checkJobMaterial(db, orgId, job, deviceId, file?.filename ?? job.file_ref, file?.bytes);
      if (refusal) {
        await releaseSend(db, jobId, token);
        return { ok: false, code: "material_not_ready", message: refusal };
      }
    }
    sub = await driver.submitJob({ fileId: job.remote_file_id, deviceId, idempotencyKey: token });
  } catch (e) {
    await releaseSend(db, jobId, token);
    throw e;
  }
  const status = sub.queued ? "sent" : "awaiting-assignment";
  const remoteJobId = sub.jobId ? String(sub.jobId) : null; // ""/undefined → null (see sendJob)
  await db
    .updateTable("digifab_jobs")
    .set({
      remote_job_id: remoteJobId,
      target_device: sub.deviceId ?? deviceId,
      target_tag: null, // a specific printer was chosen — drop the ambiguous tag
      status,
      send_token: null,
      send_claimed_at: null,
      sent_at: new Date(),
      error: sub.queued && !remoteJobId ? "the manager accepted the job but returned no job id. Cobblr can't track it to completion" : null,
      poll_errors: 0,
      unreachable_since: null,
      updated_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();
  void platform().events.emit("digifab.job.sent", { orgId, jobId, status });
  await commitBuildIfLinked(db, orgId, jobId, job, status);
  if (sub.queued) {
    const placed = sub.deviceId ?? deviceId;
    const cam = await cameraFor(db, job.connection_id, placed);
    void notifyPrint(orgId, { kind: "started", jobId, fileRef: job.file_ref, device: placed, cameraUrl: cam, gramsUsed: job.material_grams != null ? Number(job.material_grams) : null });
  }
  return { ok: true, status, remoteJobId, placement: sub, shouldPoll: !!(sub.queued && remoteJobId) };
}
