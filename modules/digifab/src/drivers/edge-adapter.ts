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

import { hasKilnPermit, type KilnPermit } from "../kilns/station.js";
import { createHash, randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaserSetupSchema, LaserCommissionSchema, type LaserSetup, type LaserCommission } from "@cobblr/platform-contract/laser-setup";
import { EdgeUnsupported } from "@cobblr/platform-contract";
import { DriverSaid, sentenceIn } from "../job-truth.js";
import { ReviewRequired } from "./job-review.js";
import type {
  CommandResult,
  ControlDef,
  ConnectionResult,
  ManagerConfig,
  MachineDriver,
  DeviceTemps,
  DeviceJob,
  JobReview,
  JobState,
  JobStatus,
  PlacementResolution,
  RemoteDevice,
  RemoteFile,
  RemoteFileInfo,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";
import { assertSafeMachineUrl } from "./ssrf.js";
import { edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";

/** A relay transport — when present, the driver routes its edge-adapter calls
 *  through it (the cloud→edge tunnel) instead of dialing the bridge directly.
 *  Supplied by the caller (which holds platform().edge + the orgId), so this
 *  pure driver stays platform-free. Returns the agent's { status, body }. */
export type EdgeRelay = (req: { method: string; path: string; body?: unknown; timeoutMs?: number; file?: { path: string; sha256: string; size: number } }) => Promise<{ status: number; body: unknown }>;

const JOB_STATES = new Set<JobState>([
  "idle", "queued", "printing", "paused", "completed", "failed", "cancelled", "awaiting-assignment", "unknown",
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
  if (Array.isArray(r.tools)) {
    const tools: NonNullable<DeviceTemps["tools"]> = [];
    for (const raw of r.tools.slice(0, 32)) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      const temperature = pair(t);
      if (typeof t.id !== "string" || !t.id || !temperature) continue;
      const f = t.filament && typeof t.filament === "object" ? t.filament as Record<string, unknown> : {};
      const filament = {
        ...(typeof f.material === "string" && f.material ? { material: f.material.slice(0, 120) } : {}),
        ...(typeof f.vendor === "string" && f.vendor ? { vendor: f.vendor.slice(0, 120) } : {}),
        ...(typeof f.color === "string" && /^#[0-9a-f]{6}$/i.test(f.color) ? { color: f.color } : {}),
      };
      tools.push({ id: t.id.slice(0, 120), ...temperature, ...(Object.keys(filament).length ? { filament } : {}) });
    }
    if (tools.length) out.tools = tools;
  }
  return out.nozzle || out.bed || out.chamber || out.tools ? out : null;
}

function coerceJob(raw: unknown): DeviceJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: DeviceJob = {
    ...(num(r.fractionPrinted) != null ? { fractionPrinted: num(r.fractionPrinted) } : {}),
    ...(num(r.currentLayer) != null ? { currentLayer: num(r.currentLayer) } : {}),
    ...(num(r.timeLeftSec) != null ? { timeLeftSec: num(r.timeLeftSec) } : {}),
    ...(num(r.durationSec) != null ? { durationSec: num(r.durationSec) } : {}),
  };
  return Object.keys(out).length ? out : null;
}

export class EdgeAdapterDriver implements MachineDriver {
  readonly benchInstrument?:boolean;
  readonly laserBackend: MachineDriver["laserBackend"];
  readonly printProcess: MachineDriver["printProcess"];
  cancelJob?: (jobId: string) => Promise<void>;
  pauseJob?: (jobId: string) => Promise<void>;
  resumeJob?: (jobId: string) => Promise<void>;
  private knownReviewRequired: boolean;
  private knownPrintReview: boolean;
  private knownCutterReview: boolean;
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
    const edge = cfg.extra?.creds?.edge as Record<string, unknown> | undefined;
    this.benchInstrument = edge?.driver ? edge.driver === "scpi" : undefined;
    this.laserBackend = edge?.driver === "gcode-laser" ? "gcode" : edge?.driver === "ruida" ? "ruida" : edge?.driver === "galvo" ? "galvo" : undefined;
    this.knownCutterReview = edge?.driver === "cutter";
    this.printProcess = edge?.driver === "sdcp" ? "resin" : edge?.driver === "ipp" ? "large-format" : undefined;
    this.knownPrintReview = edge?.driver === "ipp" || edge?.driver === "sdcp" || edge?.driver === "snapmaker" || edge?.driver === "moonraker" && edge.profile === "snapmaker-u1";
    this.knownReviewRequired = edge?.driver === "lightburn" || this.knownPrintReview || this.knownCutterReview || this.laserBackend != null;
    if (this.knownPrintReview) {
      const control = async (id: string) => {
        const result = await this.runControl("", id, {});
        if (!result.ok) throw new Error(result.detail || "The printer did not accept the control.");
      };
      this.cancelJob = async jobId => {
        try { const result = await this.runControl("", "stop", this.printProcess === "large-format" ? {jobId} : {}); if (!result.ok) throw new Error(result.detail || "The printer did not accept Stop."); }
        catch (error) { if ((await this.getJobStatus(jobId).catch(() => null))?.state !== "idle") throw error; }
      };
      this.pauseJob = () => control("pause");
      this.resumeJob = () => control("resume");
    }
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    // Optional shared-secret: sent as a Bearer if the connection stored an apiKey.
    this.token = cfg.apiKey ?? null;
    this.relay = relay ?? null;
    const instance = edgeInstanceOf(this.base);
    this.tunnelPrefix = instance ? `/${instance}` : "";
  }

  async kilnAtStation(permit: KilnPermit, operation: "start" | "stop", params: Record<string, unknown>): Promise<CommandResult> {
    if (!hasKilnPermit(permit)) return { ok: false, detail: "Authorize at the kiln's station." };
    return await this.req("POST", "/command", { body: { command: `kiln_${operation}`, params: { ...params, device_id: permit.deviceId } } }) as CommandResult;
  }

  async identifyBench():Promise<{identity:string;profile:string}>{
    const result=await this.req("GET","/bench/identify");
    const { z }=await import("zod");
    return z.object({identity:z.string().min(1).max(512),profile:z.enum(["psu","dmm","rigol-ds1000z"])}).parse(result);
  }
  async readBench():Promise<import("../bench-model.js").BenchReport>{
    const {BenchReportSchema}=await import("../bench-model.js");
    return BenchReportSchema.parse(await this.req("GET","/bench",{timeoutMs:30000}));
  }

  async getLaserSetup():Promise<LaserSetup>{
    if(!this.laserBackend)throw new Error("Choose a direct bridge laser for station setup.");
    return LaserSetupSchema.parse(await this.req("GET","/laser/setup"));
  }
  async homeLaser(checkMotionAllowed?:()=>Promise<void>):Promise<LaserSetup>{
    return this.setupMotion("/laser/home",{},checkMotionAllowed);
  }
  async commissionLaser(configuration:LaserCommission,checkMotionAllowed?:()=>Promise<void>):Promise<LaserSetup>{
    return this.setupMotion("/laser/commission",LaserCommissionSchema.parse(configuration),checkMotionAllowed);
  }
  private async setupMotion(path:string,body:unknown,checkMotionAllowed?:()=>Promise<void>):Promise<LaserSetup>{
    if(!this.laserBackend||!checkMotionAllowed)throw new Error("Use this laser's authorized station for setup.");
    await checkMotionAllowed();
    try{
      const report=LaserSetupSchema.parse(await this.req("POST",path,{body,timeoutMs:65000}));
      await checkMotionAllowed();return report;
    }catch(error){await this.req("POST","/control",{body:{id:"stop",params:{}}}).catch(()=>{});throw error;}
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
    if (this.laserBackend && !["frame", "pause", "resume", "stop"].includes(id)) return { ok: false, detail: "Choose a direct laser control." };
    const cutter = await this.jobReviewRequired() && await this.jobReviewKind() === "cutter";
    if (cutter && !["frame", "pause", "resume", "stop", "confirm-idle"].includes(id)) return { ok: false, detail: "Choose a cutter station control." };
    if (!this.laserBackend && !cutter && await this.jobReviewRequired() && !(await this.jobReviewKind() === "print" && ["stop", "pause", "resume"].includes(id))) return { ok: false, detail: "Approve Start at the machine's station." };
    const { checkMotionAllowed, ...wireParams } = params;
    const check = (this.laserBackend || cutter) && ["frame", "confirm-idle"].includes(id) && typeof checkMotionAllowed === "function" ? checkMotionAllowed as () => Promise<void> : undefined;
    if ((this.laserBackend || cutter) && ["frame", "confirm-idle"].includes(id) && !check) return { ok: false, detail: "Frame the reviewed queued job at this laser." };
    try {
      await check?.();
      let r: { ok?: boolean; ref?: string; detail?: string };
      try {
        r = await this.req("POST", "/control", { body: { id, params: wireParams }, ...(this.laserBackend === "galvo" && id === "frame" ? {timeoutMs:65000} : {}) }) as typeof r;
        await check?.();
      } catch (e) {
        if (check) await this.req("POST", "/control", { body: { id: "stop", params: {} } }).catch(() => {});
        throw e;
      }
      return r?.ok ? { ok: true, ref: r.ref ?? id } : { ok: false, detail: r?.detail ?? "control not accepted" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** Start a file already on the machine's storage (no re-upload), via the bridge. */
  async printFile(_deviceId: string, name: string): Promise<CommandResult> {
    if (await this.jobReviewRequired()) return { ok: false, detail: "Approve at the laser's station." };
    try {
      const r = (await this.req("POST", "/print", { body: { name } })) as { ok?: boolean; ref?: string; detail?: string };
      return r?.ok ? { ok: true, ref: r.ref } : { ok: false, detail: r?.detail ?? "print not accepted" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** The gcode files already on the machine's storage, via the bridge. Best-
   *  effort — [] if the driver doesn't list files. Cobblr caches this. */
  async listFiles(): Promise<RemoteFile[]> {
    try {
      const data = (await this.req("GET", "/files")) as RemoteFile[];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /** Slicer metadata for one on-disk file (name goes in the path — the bridge
   *  router doesn't pass query strings). Best-effort → null. */
  async fileInfo(_deviceId: string, name: string): Promise<RemoteFileInfo | null> {
    try {
      const data = (await this.req("GET", `/fileinfo/${encodeURIComponent(name)}`)) as RemoteFileInfo | null;
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
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

  /** Local failure model on the bridge (grabs its own frame + runs ONNX). Null
   *  when the bridge has no model loaded (501/unsupported) or can't grab a frame,
   *  so the caller falls back to the vision-AI path. */
  async detectFailure(): Promise<{ probability: number } | null> {
    try {
      const data = (await this.req("GET", "/detect")) as { probability?: number } | null;
      return data && typeof data.probability === "number" ? { probability: data.probability } : null;
    } catch {
      return null;
    }
  }

  /** One transport for every contract call. Tunnel mode routes through the relay
   *  (the body is JSON; an upload rides as { filename, data_b64 }); direct mode
   *  dials the bridge (an upload is multipart). */
  private async req(method: string, path: string, opts: { body?: unknown; timeoutMs?: number; file?: { bytes: Uint8Array; filename: string } } = {}): Promise<unknown> {
    if (this.relay) {
      const body = opts.file
        ? { filename: opts.file.filename, data_b64: Buffer.from(opts.file.bytes).toString("base64") }
        : opts.body;
      // Prefix the instance so one bridge (one workspace channel) routes the call
      // to the right machine: "/voron" + "/devices" → "/voron/devices".
      const r = await this.relay({ method, path: this.tunnelPrefix + path, body, ...(opts.timeoutMs ? {timeoutMs:opts.timeoutMs} : {}) });
      if (r.status >= 400) {
        // The bridge says why in a sentence (an allowlist refusal, a service
        // that did not answer). Keep its words; a 403 from the bridge is not a
        // refused key.
        const said = sentenceIn(r.body);
        throw said ? new DriverSaid(r.status, said) : new Error(`adapter ${method} ${this.tunnelPrefix + path} → ${r.status} (tunnel)`);
      }
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
    const res = await fetch(this.base + path, { method, headers, body: fetchBody, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
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
      station_kind: d.station_kind === "print" || d.station_kind === "laser" || d.station_kind === "cutter" ? d.station_kind : undefined,
      camera_available: d.camera_available === true,
      state: (d.state as string | undefined) ?? null,
      tags: [],
      temps: coerceTemps(d.temps),
      job: coerceJob(d.job),
      stage: typeof d.stage === "string" && d.stage ? d.stage : null,
      raw: d.raw && typeof d.raw === "object" ? (d.raw as Record<string, unknown>) : null,
    }));
  }

  async setDeviceEnabled(): Promise<void> {
    // Optional in the contract; no-op keeps state-sync best-effort.
  }

  async jobReviewRequired(): Promise<boolean> {
    if (this.knownReviewRequired) return true;
    try {
      const data = await this.req("GET", "/capabilities") as { jobReview?: boolean; jobReviewKind?: unknown };
      if (data?.jobReviewKind === "print") this.knownPrintReview = true;
      if (data?.jobReviewKind === "cutter") this.knownCutterReview = true;
      return this.knownReviewRequired || data?.jobReview === true;
    } catch (e) {
      const unsupported = e instanceof DriverSaid ? [404, 501].includes(e.status) : e instanceof Error && /adapter GET \/capabilities → (?:404|501)(?::|$)/.test(e.message);
      if (unsupported) {
        const devices = await this.listDevices();
        return this.knownReviewRequired || devices.some(device => device.id === "lightburn" || device.name === "LightBurn");
      }
      throw e;
    }
  }

  async jobReviewKind(): Promise<"laser" | "print" | "cutter"> {
    if (this.knownCutterReview) return "cutter";
    if (this.knownPrintReview) return "print";
    if (this.knownReviewRequired) return "laser";
    const data = await this.req("GET", "/capabilities") as { jobReviewKind?: unknown };
    return data?.jobReviewKind === "cutter" ? "cutter" : data?.jobReviewKind === "print" ? "print" : "laser";
  }

  async prepareJob(file: Uint8Array, filename: string): Promise<JobReview> {
    return await this.upload("/prepare", file, filename) as JobReview;
  }

  async getJobReview(fileId: string): Promise<JobReview> {
    return await this.req("GET", `/review/${encodeURIComponent(fileId)}`) as JobReview;
  }

  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    const data = await this.upload("/upload", file, filename) as { fileId?: string };
    return { fileId: data?.fileId ?? filename, filename };
  }

  private async upload(path: string, file: Uint8Array, filename: string): Promise<unknown> {
    if (this.relay) {
      // Through a bridge the file goes on its blob channel, never inside the
      // relay's JSON (a database row, capped at 20 MB, where a real 3MF did not
      // fit). A bridge too old for files gets it the old way.
      const spool = join(tmpdir(), `cobblr-upload-${randomUUID()}`);
      try {
        await writeFile(spool, file);
        const r = await this.relay({
          method: "POST",
          path: this.tunnelPrefix + path,
          body: { filename },
          file: { path: spool, sha256: createHash("sha256").update(file).digest("hex"), size: file.length },
        });
        if (r.status >= 400) {
          const said = sentenceIn(r.body);
          throw said ? new DriverSaid(r.status, said) : new Error(`adapter POST ${this.tunnelPrefix}/upload → ${r.status} (tunnel)`);
        }
        return r.body;
      } catch (e) {
        if (!(e instanceof EdgeUnsupported)) throw e;
      } finally {
        await unlink(spool).catch(() => {});
      }
    }
    return this.req("POST", path, { file: { bytes: file, filename } });
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    if (await this.jobReviewRequired() && !args.approval) throw new ReviewRequired("Approve at the laser's station.");
    const cutter = await this.jobReviewRequired() && await this.jobReviewKind() === "cutter";
    if ((this.laserBackend || cutter || ["resin", "large-format"].includes(this.printProcess ?? "")) && !args.checkStartAllowed) throw new ReviewRequired("Approve at the machine's station.");
    const check = args.checkStartAllowed;
    await check?.();
    let data: { jobId?: string; queued?: boolean } | undefined;
    try {
      data = await this.req("POST", "/submit", {
        body: { ...(args.approval ? { approval: args.approval } : {}), fileId: args.fileId, target: args.deviceId ?? args.tag ?? null, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) },
      }) as typeof data;
      await check?.();
    } catch (e) {
      if (this.laserBackend || cutter || ["resin", "large-format"].includes(this.printProcess ?? "")) await this.req("POST", "/control", { body: { id: "stop", params: {} } }).catch(() => {});
      if ((cutter || this.printProcess === "large-format") && data?.jobId) return { jobId: data.jobId, deviceId: args.deviceId ?? null, queued: true, status: "queued", interrupted: true };
      throw e;
    }
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
    if (command === "kiln_start" || command === "kiln_stop") return { ok: false, detail: "Use the authorized kiln station." };

    if (await this.jobReviewRequired()) return { ok: false, detail: "Approve at the laser's station." };
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
