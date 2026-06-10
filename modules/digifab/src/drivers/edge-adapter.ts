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
//
// `edge_adapter` is a BUILT-IN driver key (always available); no install
// needed — just create a connection pointing base_url at your bridge.

import type {
  ConnectionResult,
  ManagerConfig,
  MachineDriver,
  JobState,
  JobStatus,
  PlacementResolution,
  RemoteDevice,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";
import { assertSafeMachineUrl } from "./ssrf.js";

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

export class EdgeAdapterDriver implements MachineDriver {
  private base: string;
  constructor(cfg: ManagerConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    // Optional shared-secret: sent as a Bearer if the connection stored an apiKey.
    this.token = cfg.apiKey ?? null;
  }
  private token: string | null;

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  private async json(method: string, path: string, init: RequestInit = {}): Promise<unknown> {
    await assertSafeMachineUrl(this.base + path);
    const res = await fetch(this.base + path, {
      ...init,
      method,
      headers: { ...(init.headers as Record<string, string>), ...this.headers() },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`adapter ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.json("GET", "/devices");
      return { ok: true, capabilities: { routing: false } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, capabilities: { routing: false } };
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const data = (await this.json("GET", "/devices")) as Array<Record<string, unknown>>;
    return (Array.isArray(data) ? data : []).map((d) => ({
      id: String(d.id ?? ""),
      name: String(d.name ?? "device"),
      enabled: d.enabled !== false,
      state: (d.state as string | undefined) ?? null,
      tags: [],
    }));
  }

  async setDeviceEnabled(): Promise<void> {
    // Optional in the contract; no-op keeps state-sync best-effort.
  }

  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", new Blob([file]), filename);
    const data = (await this.json("POST", "/upload", { body: form })) as { fileId?: string };
    return { fileId: data?.fileId ?? filename, filename };
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    const data = (await this.json("POST", "/submit", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: args.fileId, target: args.deviceId ?? args.tag ?? null }),
    })) as { jobId?: string; queued?: boolean };
    const jobId = data?.jobId ?? null;
    const queued = data?.queued ?? !!jobId;
    return { jobId, deviceId: args.deviceId ?? null, queued, status: queued ? "queued" : "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const data = (await this.json("GET", `/status/${encodeURIComponent(jobId)}`)) as { state?: unknown; progress?: unknown };
    const p = Number(data?.progress);
    return {
      jobId,
      state: coerceState(data?.state),
      progress: Number.isFinite(p) ? (p > 1 ? p / 100 : p) : null,
      deviceId: null,
      raw: data,
    };
  }
}
