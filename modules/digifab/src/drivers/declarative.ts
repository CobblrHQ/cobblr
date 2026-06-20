// Declarative HTTP driver engine — turns a DriverManifest (data) into a
// live MachineDriver. The only code that ships; new REST machine managers are
// installed as manifests, no deploy. Covers OctoPrint / Duet / Moonraker /
// PrusaLink / CNCjs — the request/response-shaped majority. (MQTT / weird
// auth → the edge-adapter form instead.)

import type {
  CommandResult,
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
  // Live-control of a running print. Defined ONLY when the manifest carries the
  // matching command, so a manager without it stays cleanly "unsupported" (the
  // API 501s on a missing method) instead of failing at call time. A manifest
  // adds pause/resume/cancel by declaring `commands.{pause,resume,cancel}`.
  pauseJob?: (jobId: string) => Promise<void>;
  resumeJob?: (jobId: string) => Promise<void>;
  cancelJob?: (jobId: string) => Promise<void>;
  constructor(private manifest: DriverManifest, private cfg: ManagerConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    const cmds = this.manifest.commands ?? {};
    if (cmds.pause) this.pauseJob = (jobId) => this.runJobCommand("pause", jobId);
    if (cmds.resume) this.resumeJob = (jobId) => this.runJobCommand("resume", jobId);
    if (cmds.cancel) this.cancelJob = (jobId) => this.runJobCommand("cancel", jobId);
  }

  /** Run a job-control command (pause/resume/cancel) from the manifest. The job's
   *  ref is exposed as {jobId} + {fileId} so a manager that needs it in the path/
   *  body can template it; static commands ignore them. Throws on a non-ok manager
   *  response so the API surfaces the failure rather than a silent no-op. */
  private async runJobCommand(name: string, jobId: string): Promise<void> {
    const r = await this.runCommand(name, { jobId, fileId: jobId });
    if (!r.ok) throw new Error(r.detail ?? `${name} not accepted by the manager`);
  }

  // ── helpers ──────────────────────────────────────────────────────────
  private authHeaders(): Record<string, string> {
    const a = this.manifest.auth;
    if (!a) return {};
    const v = a.from === "apiKey" ? this.cfg.apiKey : a.from === "username" ? this.cfg.username : this.cfg.password;
    return v ? { [a.header]: `${a.prefix ?? ""}${String(v)}` } : {};
  }

  /** Substitute {fileId}/{jobId}/… in a path from the call vars. */
  private path(template: string, vars: Record<string, string> = {}): string {
    return this.base + template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ""));
  }

  /** Substitute {var} in the string values of a submit body (deep). Lets a
   *  manifest put `{filename}` into a JSON command body (Duet's M32, etc.). */
  private fillBody(body: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
    const sub = (v: unknown): unknown =>
      typeof v === "string"
        ? v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "")
        : Array.isArray(v)
          ? v.map(sub)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, sub(val)]))
            : v;
    return sub(body) as Record<string, unknown>;
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
    await assertSafeMachineUrl(path);
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
    if (!m) throw new Error("this driver has no upload step (actuator-only manifest)");
    const url = this.path(m.path, { filename });
    let data: unknown;
    if (m.body === "raw") {
      // The file bytes ARE the request body (Duet rr_upload, PrusaLink PUT).
      // Filename rides in the path via {filename}.
      data = await this.json(m.method, url, {
        headers: { "content-type": m.contentType ?? "application/octet-stream" },
        body: file,
      });
    } else {
      const form = new FormData();
      form.append(m.fileField, new Blob([file]), filename);
      data = await this.json(m.method, url, { body: form });
    }
    return { fileId: this.extract(m.result.fileId, data, { filename }) || filename, filename };
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    // Declarative drivers place via submit; no separate routing preview.
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    const m = this.manifest.submit;
    if (!m) throw new Error("this driver has no submit step (actuator-only manifest)");
    // For raw-upload managers the "fileId" IS the filename, so expose both.
    const vars = { fileId: args.fileId, filename: args.fileId, deviceId: args.deviceId ?? "", tag: args.tag ?? "" };
    const data = await this.json(m.method, this.path(m.path, vars), {
      headers: m.body ? { "content-type": "application/json" } : {},
      body: m.body ? JSON.stringify(this.fillBody(m.body, vars)) : undefined,
    });
    const jobId = this.extract(m.result.jobId, data, vars) || null;
    const queued = m.result.queued ? this.extract(m.result.queued, data, vars) === "true" : !!jobId;
    return { jobId, deviceId: args.deviceId ?? null, queued, status: queued ? "queued" : "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const m = this.manifest.status;
    if (!m) throw new Error("this driver has no status step (actuator-only manifest)");
    const url = this.path(m.path, { jobId });
    let upstream: string;
    let progressStr: string | null = null;
    let raw: unknown;
    if (m.parse === "text") {
      // Plain-text status (GRBL `<Idle|MPos:..>` etc.): `from`/`progress` are
      // REGEXES; use the first capture group against the raw body.
      const res = await this.req(m.method, url);
      const text = res.ok ? await res.text() : "";
      raw = text;
      upstream = matchGroup(m.result.state.from, text);
      if (m.result.progress) progressStr = matchGroup(m.result.progress, text);
    } else {
      const data = await this.json(m.method, url);
      raw = data;
      upstream = this.extract(m.result.state.from, data, { jobId });
      if (m.result.progress) progressStr = this.extract(m.result.progress, data, { jobId });
    }
    const mapped = m.result.state.map[upstream] ?? "unknown";
    const state = (JOB_STATES.has(mapped as JobState) ? mapped : "unknown") as JobState;
    let progress: number | null = null;
    if (progressStr != null && progressStr !== "") {
      const p = Number(progressStr);
      if (Number.isFinite(p)) progress = p > 1 ? p / 100 : p;
    }
    return { jobId, state, progress, deviceId: null, raw };
  }

  // ── ActuatorDriver (the command-and-forget shape) ────────────────────────
  /** Fire a parameterized command from the manifest's `commands[name]`:
   *  `{param}` placeholders in the path + body string-values are filled from
   *  the command's params (the wire's per-entity args). No file, no job. */
  async runCommand(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    const c = this.manifest.commands?.[command];
    if (!c) return { ok: false, detail: `unknown command "${command}"` };
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) vars[k] = v == null ? "" : String(v);
    const url = this.path(c.path, vars);
    try {
      const res = await this.req(c.method, url, {
        headers: c.body ? { "content-type": "application/json" } : {},
        body: c.body ? JSON.stringify(this.fillBody(c.body, vars)) : undefined,
      });
      return res.ok
        ? { ok: true, ref: `${c.method} ${url}` }
        : { ok: false, detail: `status ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

/** First capture group of `pattern` against `text`, or "" if no match. */
function matchGroup(pattern: string, text: string): string {
  try {
    const m = new RegExp(pattern).exec(text);
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}
