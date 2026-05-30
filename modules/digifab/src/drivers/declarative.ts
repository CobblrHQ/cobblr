// Declarative HTTP driver engine — turns a DriverManifest (data) into a
// live MachineDriver. The only code that ships; new REST machine managers are
// installed as manifests, no deploy. Covers OctoPrint / Duet / Moonraker /
// PrusaLink / CNCjs — the request/response-shaped majority. (MQTT / weird
// auth → the edge-adapter form instead.)

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
import type { DriverManifest } from "./manifest.js";
import { assertSafeMachineUrl } from "./ssrf.js";

const JOB_STATES = new Set<JobState>([
  "queued", "printing", "paused", "completed", "failed", "cancelled", "awaiting-assignment", "unknown",
]);

export class DeclarativeDriver implements MachineDriver {
  private base: string;
  constructor(private manifest: DriverManifest, private cfg: ManagerConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
  }

  // ── helpers ──────────────────────────────────────────────────────────
  private authHeaders(): Record<string, string> {
    const a = this.manifest.auth;
    if (!a) return {};
    const v = a.from === "apiKey" ? this.cfg.apiKey : a.from === "username" ? this.cfg.username : this.cfg.password;
    return v ? { [a.header]: String(v) } : {};
  }

  /** Substitute {fileId}/{jobId}/… in a path from the call vars. */
  private path(template: string, vars: Record<string, string> = {}): string {
    return this.base + template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
  }

  /** Evaluate an extract expr against a response + vars. */
  private extract(expr: string, data: unknown, vars: Record<string, string> = {}): string {
    if (expr.startsWith("='") && expr.endsWith("'")) return expr.slice(2, -1);
    if (expr.startsWith("={") && expr.endsWith("}")) return vars[expr.slice(2, -1)] ?? "";
    if (expr.startsWith("$.")) {
      let cur: unknown = data;
      for (const key of expr.slice(2).split(".")) {
        if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
        else return "";
      }
      return cur == null ? "" : String(cur);
    }
    return expr;
  }

  private async req(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    assertSafeMachineUrl(path);
    return fetch(path, {
      ...init,
      method,
      headers: { ...(init.headers as Record<string, string>), ...this.authHeaders() },
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async json(method: string, path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.req(method, path, init);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  // ── MachineDriver ───────────────────────────────────────────────────────
  async testConnection(): Promise<ConnectionResult> {
    try {
      const res = await this.req(this.manifest.test.method, this.path(this.manifest.test.path));
      return { ok: res.ok, detail: res.ok ? undefined : `status ${res.status}`, capabilities: { routing: !!this.manifest.routing } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, capabilities: { routing: false } };
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const m = this.manifest.listDevices;
    const data = await this.json(m.method, this.path(m.path));
    const rows: unknown[] = m.result === "single" ? [data] : ((m.arrayPath ? this.deref(data, m.arrayPath) : data) as unknown[]) ?? [];
    return (Array.isArray(rows) ? rows : []).map((d) => ({
      id: this.extract(m.map.id, d),
      name: this.extract(m.map.name, d) || "device",
      enabled: m.map.enabled ? this.extract(m.map.enabled, d) !== "false" : true,
      state: m.map.state ? this.extract(m.map.state, d) : null,
      tags: [],
    }));
  }

  private deref(data: unknown, dotPath: string): unknown {
    let cur: unknown = data;
    for (const key of dotPath.replace(/^\$\./, "").split(".")) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
      else return undefined;
    }
    return cur;
  }

  async setDeviceEnabled(): Promise<void> {
    // Most declarative managers don't expose this; a no-op keeps the
    // machine-state sync best-effort rather than erroring.
  }

  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    const m = this.manifest.upload;
    const form = new FormData();
    form.append(m.fileField, new Blob([file]), filename);
    const data = await this.json(m.method, this.path(m.path), { body: form });
    return { fileId: this.extract(m.result.fileId, data) || filename, filename };
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    // Declarative drivers place via submit; no separate routing preview.
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    const m = this.manifest.submit;
    const vars = { fileId: args.fileId, deviceId: args.deviceId ?? "", tag: args.tag ?? "" };
    const data = await this.json(m.method, this.path(m.path, vars), {
      headers: m.body ? { "content-type": "application/json" } : {},
      body: m.body ? JSON.stringify(m.body) : undefined,
    });
    const jobId = this.extract(m.result.jobId, data, vars) || null;
    const queued = m.result.queued ? this.extract(m.result.queued, data, vars) === "true" : !!jobId;
    return { jobId, deviceId: args.deviceId ?? null, queued, status: queued ? "queued" : "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const m = this.manifest.status;
    const data = await this.json(m.method, this.path(m.path, { jobId }));
    const upstream = this.extract(m.result.state.from, data, { jobId });
    const mapped = m.result.state.map[upstream] ?? "unknown";
    const state = (JOB_STATES.has(mapped as JobState) ? mapped : "unknown") as JobState;
    let progress: number | null = null;
    if (m.result.progress) {
      const p = Number(this.extract(m.result.progress, data, { jobId }));
      if (Number.isFinite(p)) progress = p > 1 ? p / 100 : p;
    }
    return { jobId, state, progress, deviceId: null, raw: data };
  }
}
