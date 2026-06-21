// Edge-adapter driver — the escape hatch for managers the declarative
// HTTP engine can't express (MQTT, handshake auth, binary). The user runs
// a tiny bridge at the edge; digifab speaks a FIXED webhook contract to it
// and the bridge translates to the real machine. Pure coordinate-not-
// control: digifab only ever HTTPs to the bridge.
//
// The connection's base_url IS the bridge URL. Contract the bridge serves:
//   GET  {base}/devices            → [ { id, name, state, enabled? } ]
//   POST {base}/upload  (multipart "file") → { fileId }
//   POST {base}/submit  { fileId, target? } → { jobId, queued? }
//   GET  {base}/status/{jobId}     → { state, progress? }
//   POST {base}/command { command, params } → { ok, ref? }   (actuator; optional)
//
// `edge_adapter` is a BUILT-IN driver key (always available); no install
// needed — just create a connection pointing base_url at your bridge.

import type {
  CommandResult,
  ControlDef,
  ConnectionResult,
  ManagerConfig,
  MachineDriver,
  DeviceTemps,
  JobState,
  JobStatus,
  PlacementResolution,
  RemoteDevice,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";
import { assertSafeMachineUrl } from "./ssrf.js";

/** A relay transport — when present, the driver routes its edge-adapter calls
 *  through it (the cloud→edge tunnel) instead of dialing the bridge directly.
 *  Supplied by the caller (which holds platform().edge + the orgId), so this
 *  pure driver stays platform-free. Returns the agent's { status, body }. */
export type EdgeRelay = (req: { method: string; path: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;

const JOB_STATES = new Set<JobState>([
  "queued", "printing", "paused", "completed", "failed", "cancelled", "awaiting-assignment", "unknown",
]);

function coerceState(raw: unknown): JobState {
  const s = String(raw ?? "").toLowerCase();
  if (JOB_STATES.has(s as JobState)) return s as JobState;
  if (/print|run|start/.test(s)) return "printing";
  if (/done|complete|finish|success/.test(s)) return "completed";
  if (/cancel|abort/.test(s)) return "cancelled";
  if (/fail|error/.test(s)) return "failed";
  if (/pause/.test(s)) return "paused";
  if (/queue|pending|schedul/.test(s)) return "queued";
  return "unknown";
}

/** Coerce a bridge's free-form temps JSON into DeviceTemps. Display-only; drops
 *  anything malformed rather than throwing. */
function coerceTemps(raw: unknown): DeviceTemps | null {
  if (!raw || typeof raw !== "object") return null;
  const pair = (v: unknown): { actual: number; target?: number } | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as { actual?: unknown; target?: unknown };
    if (typeof o.actual !== "number" || !Number.isFinite(o.actual)) return null;
    return typeof o.target === "number" && Number.isFinite(o.target)
      ? { actual: o.actual, target: o.target }
      : { actual: o.actual };
  };
  const r = raw as Record<string, unknown>;
  const out: DeviceTemps = {};
  const nozzle = pair(r.nozzle); if (nozzle) out.nozzle = nozzle;
  const bed = pair(r.bed); if (bed) out.bed = bed;
  const chamber = pair(r.chamber); if (chamber) out.chamber = chamber;
  return out.nozzle || out.bed || out.chamber ? out : null;
}

export class EdgeAdapterDriver implements MachineDriver {
  private base: string;
  private token: string | null;
  private relay: EdgeRelay | null;
  /** Tunnel mode only: the instance segment ("/voron") parsed from a
   *  `cobblr-edge://<instanceId>` base_url. ONE bridge fronts MANY machines, each
   *  a named instance; the relay carries one channel per workspace, so requests
   *  must say WHICH instance — we prefix the edge-adapter path with it. Empty for
   *  a bare `cobblr-edge://` (single-instance bridge picks its only one). */
  private tunnelPrefix: string;
  constructor(cfg: ManagerConfig, relay?: EdgeRelay | null) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    // Optional shared-secret: sent as a Bearer if the connection stored an apiKey.
    this.token = cfg.apiKey ?? null;
    this.relay = relay ?? null;
    const m = /^cobblr-edge:\/\/(.*)$/i.exec(this.base);
    const id = (m?.[1] ?? "").replace(/^\/+|\/+$/g, "");
    this.tunnelPrefix = id ? `/${id}` : "";
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  /** The live controls the bridge's driver declares (pause/resume/stop + …).
   *  Best-effort — [] if the bridge/driver has none. */
  async listControls(): Promise<ControlDef[]> {
    try {
      const data = (await this.req("GET", "/controls")) as ControlDef[];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Run a declared control through the bridge. */
  async runControl(_deviceId: string, id: string, params: Record<string, unknown>): Promise<CommandResult> {
    try {
      const r = (await this.req("POST", "/control", { body: { id, params } })) as { ok?: boolean; ref?: string; detail?: string };
      return r?.ok ? { ok: true, ref: r.ref ?? id } : { ok: false, detail: r?.detail ?? "control not accepted" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** Grab one JPEG camera frame (the bridge returns it base64 over the JSON
   *  contract). Best-effort — null if the driver/printer has no camera. */
  async getCameraFrame(): Promise<Buffer | null> {
    try {
      const data = (await this.req("GET", "/camera")) as { jpeg_b64?: string };
      return data?.jpeg_b64 ? Buffer.from(data.jpeg_b64, "base64") : null;
    } catch {
      return null;
    }
  }

  /** One transport for every contract call. Tunnel mode routes through the relay
   *  (the body is JSON; an upload rides as { filename, data_b64 }); direct mode
   *  dials the bridge (an upload is multipart). */
  private async req(method: string, path: string, opts: { body?: unknown; file?: { bytes: Uint8Array; filename: string } } = {}): Promise<unknown> {
    if (this.relay) {
      const body = opts.file
        ? { filename: opts.file.filename, data_b64: Buffer.from(opts.file.bytes).toString("base64") }
        : opts.body;
      // Prefix the instance so one bridge (one workspace channel) routes the call
      // to the right machine: "/voron" + "/devices" → "/voron/devices".
      const r = await this.relay({ method, path: this.tunnelPrefix + path, body });
      if (r.status >= 400) throw new Error(`adapter ${method} ${this.tunnelPrefix + path} → ${r.status} (tunnel)`);
      return r.body ?? null;
    }
    await assertSafeMachineUrl(this.base + path);
    let fetchBody: FormData | string | undefined;
    const headers = this.headers();
    if (opts.file) {
      const form = new FormData();
      form.append("file", new Blob([opts.file.bytes]), opts.file.filename);
      fetchBody = form;
    } else if (opts.body !== undefined) {
      fetchBody = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(this.base + path, { method, headers, body: fetchBody, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`adapter ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.req("GET", "/devices");
      return { ok: true, capabilities: { routing: false } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, capabilities: { routing: false } };
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const data = (await this.req("GET", "/devices")) as Array<Record<string, unknown>>;
    return (Array.isArray(data) ? data : []).map((d) => ({
      id: String(d.id ?? ""),
      name: String(d.name ?? "device"),
      enabled: d.enabled !== false,
      state: (d.state as string | undefined) ?? null,
      tags: [],
      temps: coerceTemps(d.temps),
      stage: typeof d.stage === "string" && d.stage ? d.stage : null,
      raw: d.raw && typeof d.raw === "object" ? (d.raw as Record<string, unknown>) : null,
    }));
  }

  async setDeviceEnabled(): Promise<void> {
    // Optional in the contract; no-op keeps state-sync best-effort.
  }

  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    const data = (await this.req("POST", "/upload", { file: { bytes: file, filename } })) as { fileId?: string };
    return { fileId: data?.fileId ?? filename, filename };
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    const data = (await this.req("POST", "/submit", {
      body: { fileId: args.fileId, target: args.deviceId ?? args.tag ?? null },
    })) as { jobId?: string; queued?: boolean };
    const jobId = data?.jobId ?? null;
    const queued = data?.queued ?? !!jobId;
    return { jobId, deviceId: args.deviceId ?? null, queued, status: queued ? "queued" : "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const data = (await this.req("GET", `/status/${encodeURIComponent(jobId)}`)) as { state?: unknown; progress?: unknown };
    const p = Number(data?.progress);
    return {
      jobId,
      state: coerceState(data?.state),
      progress: Number.isFinite(p) ? (p > 1 ? p / 100 : p) : null,
      deviceId: null,
      raw: data,
    };
  }

  // The ACTUATOR verb — POST the command + params to the bridge's /command and
  // map its ack. Fire-and-forget: no file, no job to poll. A bridge that only
  // fabricates answers /command with 501, which `json()` raises and we return as
  // a soft failure (mirrors the declarative driver — never throws to the action
  // handler, which only reads `ok`). This is what makes an `edge_adapter`
  // connection a valid target of the digifab:run-command action.
  async runCommand(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    try {
      const data = (await this.req("POST", "/command", {
        body: { command, params },
      })) as { ok?: unknown; ref?: unknown; detail?: unknown } | null;
      if (data && data.ok === false) {
        return { ok: false, detail: data.detail != null ? String(data.detail) : "adapter reported failure" };
      }
      return { ok: true, ref: data?.ref != null ? String(data.ref) : undefined };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
