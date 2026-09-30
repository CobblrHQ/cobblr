// Services: Cobblr calling an outside program that does work (design a part,
// slice a model, identify a photo), and the contract that program keeps.
// docs/design-decisions/services.md is the spec; this file is its types, so
// the kernel, the Connections page, the surfaces and module code all build
// against one shape.
//
//   §3  the manifest a service publishes (ServiceManifest, parseServiceManifest,
//       SERVICE_MANIFEST_JSON_SCHEMA)
//   §4  the job protocol on the wire (RemoteServiceJob, ServiceSubmitBody,
//       the error codes)
//   §9  the effect a capability declares, which consent reads
//   §10 the kernel seam, platform().services (PlatformServices)
//
// Pure: no I/O, no node imports, so the web app can read the same types. The
// request signer is server-only and lives in ./service-auth.

import { z } from "zod";

// ── Words ───────────────────────────────────────────────────────────────

/** What a capability does to the world, which decides who has to say yes
 *  (§9). Cobblr may treat a capability as MORE than it declares, never less. */
export const SERVICE_EFFECTS = ["none", "writes", "physical", "spends"] as const;
export type ServiceEffect = (typeof SERVICE_EFFECTS)[number];

/** How strongly an effect needs a person: the order a declaration may only
 *  be raised along. */
export const SERVICE_EFFECT_RANK: Record<ServiceEffect, number> = { none: 0, writes: 1, spends: 2, physical: 3 };

/** The stronger of two effects (a person or the platform raising one). */
export function strongerEffect(a: ServiceEffect, b: ServiceEffect): ServiceEffect {
  return SERVICE_EFFECT_RANK[a] >= SERVICE_EFFECT_RANK[b] ? a : b;
}

export type ServiceMode = "async" | "sync";

/** A capability id is dotted (`slice.model`, `design.part`). AI capability
 *  ids never contain a dot, so the two share the per-capability rank rows
 *  without colliding. */
export const SERVICE_CAPABILITY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export function isServiceCapabilityId(id: string): boolean {
  return SERVICE_CAPABILITY_ID.test(id);
}

/** The error codes a service answers with, so Cobblr can say something
 *  useful without knowing the service. A service's own codes start `x-`. */
export const SERVICE_ERROR_CODES = [
  "unsupported_printer",
  "unsupported_filament",
  "unsupported_input",
  "model_invalid",
  "not_watertight",
  "too_large",
  "busy",
  "bad_signature",
  "hash_mismatch",
  "idempotency_conflict",
  "input_timeout",
  "internal",
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number] | `x-${string}`;

/** Every non-2xx body a service sends, and a failed job's `error`. */
export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
  /** Another service in the order may answer (busy, overloaded, unreachable). */
  retryable: boolean;
}

/** The HTTP status each protocol error comes with (conformance kit). */
export const SERVICE_ERROR_STATUS: Partial<Record<ServiceErrorCode, number>> = {
  bad_signature: 401,
  hash_mismatch: 400,
  unsupported_input: 400,
  idempotency_conflict: 409,
  too_large: 413,
  busy: 503,
  internal: 500,
};

// ── §3 The manifest ─────────────────────────────────────────────────────

/** Served unauthenticated at this path under a service's base URL. */
export const SERVICE_MANIFEST_PATH = "/.well-known/cobblr-service.json";

export interface ServiceFileSpec {
  /** The key the file goes under in a submit's or a job's `files`. */
  name: string;
  /** Accepted (in) or possible (out) media types. */
  types: string[];
  required?: boolean;
  /** An extra output a service may add (a plain G-code beside a 3MF). */
  optional?: boolean;
}

export interface ServiceCapabilityDecl {
  id: string;
  version: number;
  /** What a person reads on a card. */
  title: string;
  /** What the assistant reads to pick a capability: plain prose, ≤ 300. */
  summary: string;
  effect: ServiceEffect;
  mode: ServiceMode;
  typical_seconds?: number;
  /** JSON Schema 2020-12 (may `$ref` the manifest's `$defs`). */
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  files_in?: ServiceFileSpec[];
  files_out?: ServiceFileSpec[];
  /** Live choices a schema cannot hold (printer models, templates). */
  options_endpoint?: string;
}

export interface ServiceManifest {
  cobblr_service: 1;
  /** Reverse-DNS id, stable across versions ("org.example.slicer"). */
  id: string;
  name: string;
  version: string;
  publisher?: string;
  docs_url?: string;
  auth: { schemes: string[] };
  api: { base_path: string };
  limits?: { max_file_mb?: number; max_concurrent_jobs?: number };
  /** What the service needs beyond itself, for the connect screen ("llm"). */
  requires?: string[];
  capabilities: ServiceCapabilityDecl[];
  $defs?: Record<string, unknown>;
}

const JsonSchemaObject = z.record(z.unknown());
const FileSpec = z.object({
  name: z.string().min(1).max(64),
  types: z.array(z.string().min(1).max(120)).min(1),
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
});
const CapabilityDecl = z.object({
  id: z.string().regex(SERVICE_CAPABILITY_ID, "a capability id is dotted: slice.model"),
  version: z.number().int().min(1),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  effect: z.enum(SERVICE_EFFECTS),
  mode: z.enum(["async", "sync"]),
  typical_seconds: z.number().min(0).optional(),
  input_schema: JsonSchemaObject,
  output_schema: JsonSchemaObject,
  files_in: z.array(FileSpec).optional(),
  files_out: z.array(FileSpec).optional(),
  options_endpoint: z.string().startsWith("/").optional(),
});
/** The manifest as Cobblr validates it at connect time. */
export const ServiceManifestSchema = z.object({
  cobblr_service: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "a service id is reverse-DNS: org.example.slicer"),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  publisher: z.string().max(120).optional(),
  docs_url: z.string().url().optional(),
  auth: z.object({ schemes: z.array(z.string().min(1)).min(1) }),
  api: z.object({ base_path: z.string().startsWith("/") }),
  limits: z.object({ max_file_mb: z.number().positive().optional(), max_concurrent_jobs: z.number().int().positive().optional() }).optional(),
  requires: z.array(z.string().min(1).max(40)).optional(),
  capabilities: z
    .array(CapabilityDecl)
    .min(1)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "each capability id once"),
  $defs: z.record(z.unknown()).optional(),
});

export type ServiceManifestParse =
  | { ok: true; manifest: ServiceManifest }
  | { ok: false; errors: Array<{ path: string; message: string }> };

/** Read a fetched manifest. A manifest that does not validate says which
 *  field is wrong, and a connection stops there. */
export function parseServiceManifest(raw: unknown): ServiceManifestParse {
  const r = ServiceManifestSchema.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data as ServiceManifest };
  return { ok: false, errors: r.error.issues.map((i) => ({ path: i.path.join(".") || "(manifest)", message: i.message })) };
}

/** The manifest's JSON Schema (2020-12), for a service author's own checks
 *  and the conformance kit. Says the same as ServiceManifestSchema. */
export const SERVICE_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://cobblr.xyz/schemas/cobblr-service.json",
  title: "Cobblr service manifest",
  type: "object",
  required: ["cobblr_service", "id", "name", "version", "auth", "api", "capabilities"],
  properties: {
    cobblr_service: { const: 1 },
    id: { type: "string", pattern: "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$" },
    name: { type: "string", minLength: 1, maxLength: 80 },
    version: { type: "string", minLength: 1, maxLength: 40 },
    publisher: { type: "string", maxLength: 120 },
    docs_url: { type: "string", format: "uri" },
    auth: { type: "object", required: ["schemes"], properties: { schemes: { type: "array", minItems: 1, items: { type: "string" } } } },
    api: { type: "object", required: ["base_path"], properties: { base_path: { type: "string", pattern: "^/" } } },
    limits: { type: "object", properties: { max_file_mb: { type: "number", exclusiveMinimum: 0 }, max_concurrent_jobs: { type: "integer", minimum: 1 } } },
    requires: { type: "array", items: { type: "string" } },
    capabilities: { type: "array", minItems: 1, items: { $ref: "#/$defs/capability" } },
    $defs: { type: "object" },
  },
  $defs: {
    file: {
      type: "object",
      required: ["name", "types"],
      properties: { name: { type: "string" }, types: { type: "array", minItems: 1, items: { type: "string" } }, required: { type: "boolean" }, optional: { type: "boolean" } },
    },
    capability: {
      type: "object",
      required: ["id", "version", "title", "summary", "effect", "mode", "input_schema", "output_schema"],
      properties: {
        id: { type: "string", pattern: SERVICE_CAPABILITY_ID.source },
        version: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1, maxLength: 120 },
        summary: { type: "string", minLength: 1, maxLength: 300 },
        effect: { enum: [...SERVICE_EFFECTS] },
        mode: { enum: ["async", "sync"] },
        typical_seconds: { type: "number", minimum: 0 },
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        files_in: { type: "array", items: { $ref: "#/$defs/file" } },
        files_out: { type: "array", items: { $ref: "#/$defs/file" } },
        options_endpoint: { type: "string", pattern: "^/" },
      },
    },
  },
} as const;

// §3 options answers, one fixed shape per capability family.
export interface SliceOptions {
  etag: string;
  printer_models: Array<{
    /** Neutral `<maker>/<model>` ("bambulab/a1"); Cobblr stores only this. */
    id: string;
    display_name: string;
    native_name?: string;
    build_volume_mm: [number, number, number];
    nozzles: number[];
    qualities: Array<{ id: string; layer_height_mm: number; label: string }>;
    filament_presets: Array<{ name: string; material: string }>;
    supports_auto_orient?: boolean;
    output: "gcode" | "3mf" | "bgcode";
  }>;
}
export interface DesignOptions {
  etag: string;
  templates: Array<{ id: string; title: string; summary: string; params_schema: Record<string, unknown>; preview_url?: string }>;
}

// ── §4 The job protocol on the wire ─────────────────────────────────────

/** A file on the wire: content-addressed. */
export interface ServiceWireFile {
  sha256: string;
  name?: string;
  type?: string;
  size?: number;
  /** Set by Cobblr once it holds the bytes in core-files (a question's
   *  preview on a job's `needs`), never by a service. */
  file_id?: string;
}

export interface ServiceSubmitBody {
  capability: string;
  capability_version: number;
  idempotency_key: string;
  input: unknown;
  files: Record<string, ServiceWireFile>;
  /** Offered only to a service on a direct URL; never through a bridge. */
  callback?: { url: string; token: string };
}

export const REMOTE_JOB_STATUSES = ["queued", "running", "needs_input", "done", "failed", "cancelled"] as const;
export type RemoteServiceJobStatus = (typeof REMOTE_JOB_STATUSES)[number];

/** What `GET /jobs/{id}` answers. */
export interface RemoteServiceJob {
  job_id: string;
  status: RemoteServiceJobStatus;
  progress?: number;
  message?: string;
  needs?: { prompt: string; input_schema: Record<string, unknown>; files?: Record<string, ServiceWireFile> };
  output?: unknown;
  files?: Record<string, ServiceWireFile>;
  error?: ServiceError;
  service_version?: string;
  /** sha256 of the manifest's bytes; a new one makes Cobblr re-read it. */
  manifest_version?: string;
}

/** `POST /jobs` answers 202 with this. */
export interface ServiceSubmitAnswer {
  job_id: string;
  status: RemoteServiceJobStatus;
  poll_after_s?: number;
}

/** `POST /jobs/{id}/input` takes `{ input }`. */
export interface ServiceInputBody {
  input: unknown;
}

/** Nothing leaves a terminal state. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

/** A job may wait on a person this long in needs_input, then `input_timeout`. */
export const SERVICE_NEEDS_INPUT_TTL_MS = 7 * 24 * 3600_000;
/** An unconfirmed job expires after this. */
export const SERVICE_CONFIRM_TTL_MS = 24 * 3600_000;
/** Polling backs off to this. */
export const SERVICE_POLL_MAX_S = 60;
/** An invoke past this many hops along `caused_by_job` is refused (§10),
 *  the same depth as the wire engine's own. */
export const MAX_SERVICE_HOPS = 8;

// ── §10 The kernel seam ─────────────────────────────────────────────────

/** Cobblr's own state of a job: the wire's, plus waiting for a person's yes. */
export type ServiceJobStatus = "awaiting_confirm" | RemoteServiceJobStatus;

/** Which door a job came through. Stamped by the door, never the caller's
 *  word (§10): module code calling platform().services.invoke is "module". */
export type ServiceJobOrigin = "person" | "cobb" | "mcp" | "wire" | "module";
/** The same thing named for consent: which door is asking. */
export type ServiceDoor = ServiceJobOrigin;

export interface ServiceJobRef {
  id: string;
  status: ServiceJobStatus;
}

export interface ServiceJobFile {
  file_id: string;
  name: string;
  direction: "in" | "out";
}

export interface ServiceJob {
  id: string;
  capability: string;
  /** The service connection it ran on; null for a built-in. */
  connection_id: string | null;
  /** The built-in that ran it, when no connection did. */
  built_in?: string | null;
  status: ServiceJobStatus;
  progress: number | null;
  message: string | null;
  needs: RemoteServiceJob["needs"] | null;
  input: unknown;
  output: unknown;
  files: ServiceJobFile[];
  error: ServiceError | null;
  origin: ServiceJobOrigin;
  requested_by: string | null;
  confirmed_by: string | null;
  caused_by_job: string | null;
  hop: number;
  attach_to: { kind: string; id: string } | null;
  service_version: string | null;
  created_at: string;
  updated_at: string;
}

/** One capability this person can call here, and who answers it, in order. */
export interface ServiceCapabilityView {
  id: string;
  title: string;
  summary: string;
  effect: ServiceEffect;
  input_schema: Record<string, unknown>;
  files_in: ServiceFileSpec[];
  /** Who answers, in order; the first is who runs it. */
  answered_by: ServiceChainStep[];
}

export interface ServiceChainStep {
  /** A service connection, or a built-in. */
  source: "connection" | "built-in";
  credential_id?: string;
  built_in?: string;
  /** The service's name and version as its manifest says. */
  label: string;
  /** Whose connection: the person's own, shared into the workspace, or the platform's. */
  scope: "personal" | "shared" | "platform";
}

export interface ServiceInvokeRequest {
  orgId: string;
  capability: string;
  /** Validated against the capability's input schema before anything is sent. */
  input: unknown;
  /** Input files: the manifest's `files_in` name → a core-files id. */
  files?: Record<string, string>;
  /** Pin who answers, a connection or a built-in: no fall-through to the
   *  next in the order. */
  via?: { credentialId: string } | { builtIn: string };
  idempotencyKey?: string;
  /** Outputs attach here as well as to the job. */
  attachTo?: { kind: string; id: string };
  /** The job whose result led here, for the loop guard. */
  causedByJob?: string;
}

/** What a built-in gets and gives: the same contract as a remote service,
 *  so a caller cannot tell them apart. */
export interface BuiltInServiceContext {
  orgId: string;
  jobId: string;
  input: unknown;
  /** Input files by name: core-files ids. */
  files: Record<string, string>;
  /** Report progress while it works. */
  progress(fraction: number, message?: string): Promise<void>;
  /** An adapter's connection settings (see BuiltInServiceDef.connection):
   *  the config of the connection this job runs on, decrypted. Absent for a
   *  plain built-in. */
  config?: Record<string, string>;
  /** An adapter's connection id: the key a module keeps its own per-record
   *  settings under (a detector's camera map). Absent for a plain built-in. */
  connectionId?: string;
}

/** A setting on an adapter's connection form. Flat strings only. */
export interface AdapterConfigProperty {
  type: "string";
  title: string;
  description?: string;
  /** Drawn as an address field. */
  format?: "uri";
  /** A secret: stored encrypted, never shown again. */
  writeOnly?: true;
  default?: string;
  enum?: string[];
}

/** What testing an adapter connection found. */
export interface AdapterTestResult {
  ok: boolean;
  reason?: "invalid_key" | "unreachable" | "busy" | "unknown";
  error?: string;
  /** "PrintGuard 2.1, answered in 80 ms". */
  note?: string;
}

/** A built-in that speaks a third-party program's own API (PrintGuard, Obico)
 *  needs to know where that program is. With `connection`, it is offered on
 *  Add a service like a connected service: its settings are a normal service
 *  connection (provider `adapter:<id>`, the settings as its credentials, no
 *  manifest), it is ordered like one, and each job runs with the settings of
 *  the connection it was sent to (`ctx.config`). */
export interface BuiltInConnectionDef {
  /** On the Add a service list ("PrintGuard"). */
  title: string;
  summary?: string;
  config_schema: { type: "object"; properties: Record<string, AdapterConfigProperty>; required?: string[] };
  test(config: Record<string, string>, ctx: { userId: string; orgId?: string }): Promise<AdapterTestResult>;
}

export interface BuiltInServiceResult {
  output: unknown;
  /** Output files by name: core-files ids the built-in wrote. */
  files?: Record<string, string>;
}

export interface BuiltInServiceDef {
  /** Stable id ("platform.barcode"). */
  id: string;
  name: string;
  capability: Omit<ServiceCapabilityDecl, "options_endpoint">;
  run(ctx: BuiltInServiceContext): Promise<BuiltInServiceResult>;
  /** An adapter: runs only on a connection a person made for it. */
  connection?: BuiltInConnectionDef;
}

/** The provider id an adapter's connection row carries. */
export function adapterProviderId(builtInId: string): string {
  return `adapter:${builtInId}`;
}

/** The job events wires trigger on (§10): how a flow chains. Payload:
 *  { orgId, jobId, capability, status, causedByJob, hop }. */
export const SERVICE_JOB_EVENTS = ["services.job.updated", "services.job.done", "services.job.failed", "services.job.needs_input"] as const;

/** platform().services: the one door to outside work (§10). */
export interface PlatformServices {
  /** What this person, in this workspace, can call, in order, per capability. */
  capabilities(orgId: string, userId: string | null): Promise<ServiceCapabilityView[]>;
  chainFor(orgId: string, userId: string | null, capability: string): Promise<{ steps: ServiceChainStep[] }>;
  /** The door for module code. Always returns a job at once; never waits for
   *  the work. Its origin is always "module" and it acts as no person: the
   *  caller cannot say otherwise. A physical or spends capability therefore
   *  waits in `awaiting_confirm` for a person. */
  invoke(req: ServiceInvokeRequest): Promise<ServiceJobRef>;
  job(orgId: string, jobId: string): Promise<ServiceJob | null>;
  /** Answer a job's `needs_input`. */
  answer(orgId: string, jobId: string, input: unknown, userId: string): Promise<void>;
  /** A person's yes to an `awaiting_confirm` job. Refused when what would
   *  run is not what was shown, or when this person may not run it. */
  confirm(orgId: string, jobId: string, userId: string): Promise<void>;
  cancel(orgId: string, jobId: string, userId: string | null): Promise<void>;
  /** An in-process implementation of a capability. */
  registerBuiltIn(def: BuiltInServiceDef): void;
  /** An adapter connection's settings, for the module that owns the adapter
   *  (a detector page listing the cameras behind its connection). Null
   *  unless `credentialId` is a connection of `builtInId` in this workspace:
   *  a module reads only its own adapter's settings, and only here. */
  adapterConfig(orgId: string, credentialId: string, builtInId: string): Promise<Record<string, string> | null>;
}

/** Thrown by the placeholder platform().services until the kernel lands, so a
 *  caller built early fails loudly instead of looking done. */
export class ServicesNotReadyError extends Error {
  constructor(what: string) {
    super(`services: ${what} is not built yet`);
    this.name = "ServicesNotReadyError";
  }
}
