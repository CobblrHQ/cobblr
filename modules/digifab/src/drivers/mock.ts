// Mock farm driver — an in-memory MachineDriver that lets the WHOLE
// send→poll→completed pipeline be driven end-to-end with no hardware.
// Deterministic: a job advances queued → printing → completed by poll
// count (not wall-clock), so tests never sleep. Routing is honored so the
// tag / ambiguous / awaiting-assignment paths are exercised too.
//
// Routing convention for tests: a filename may encode its target —
//   "thing@Voron 2.4.gcode"  → routes to the printer named "Voron 2.4"
//   "thing#pla.gcode"        → routes to the tag "pla" (its printer set)
// resolvePlacement reads that; submitJob({deviceId}|{tag}) overrides it.
//
// A filename containing "[fails]" prints for one poll and then fails, the
// way a spaghetti print does, so an api test can drive a failed print end to
// end over HTTP.

import type {
  CommandResult,
  ConnectionResult,
  DeviceVersions,
  MachineDriver,
  JobStatus,
  PlacementResolution,
  RemoteDevice,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";

/** Commands the mock has been asked to run — so a test can assert that the
 *  right command + params (per-entity zone/seconds) reached the driver, with no
 *  real device. Module-level so a test can read it without the driver handle. */
export const MOCK_COMMAND_LOG: Array<{ command: string; params: Record<string, unknown> }> = [];

interface MockPrinter extends RemoteDevice {}
interface MockJob {
  jobId: string;
  deviceId: string | null;
  polls: number;
  completeAfter: number;
  fail?: boolean;
  /** Fail once this many polls have passed (the "[fails]" filename marker). */
  failAfter?: number;
  cancelled?: boolean;
  paused?: boolean;
}

export interface MockOptions {
  printers?: MockPrinter[];
  /** Polls until a queued job reads "completed" (default 2). */
  completeAfter?: number;
}

/** What a mock's printers say they run: its connection URL's `firmware`,
 *  `software` and `controller` (mock://farm?firmware=6.1.3), so an api test
 *  can have a printer report a version, and then another one. */
export function mockVersions(baseUrl: string | null | undefined): DeviceVersions {
  const q = new URLSearchParams((baseUrl ?? "").split("?")[1] ?? "");
  const out: DeviceVersions = {};
  for (const k of ["firmware", "software", "controller"] as const) {
    const v = q.get(k)?.trim();
    if (v) out[k] = v.slice(0, 120);
  }
  return out;
}

const DEFAULT_PRINTERS: MockPrinter[] = [
  { id: "p1", name: "Voron 2.4", station_kind: "print", enabled: true, state: "operational", tags: ["corexy", "pla"] },
  { id: "p2", name: "Prusa MK4", station_kind: "print", enabled: true, state: "operational", tags: ["pla"] },
];

export class MockDriver implements MachineDriver {
  private printers: MockPrinter[];
  private completeAfter: number;
  private files = new Map<string, { filename: string }>();
  private jobs = new Map<string, MockJob>();
  private seq = 0;

  constructor(opts: MockOptions = {}) {
    this.printers = opts.printers ?? DEFAULT_PRINTERS.map((p) => ({ ...p }));
    this.completeAfter = opts.completeAfter ?? 2;
  }

  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, capabilities: { routing: true } };
  }

  async listDevices(): Promise<RemoteDevice[]> {
    return this.printers.map((p) => {
      // Live temps: hot while a job is actively printing on this printer, cool
      // when idle — so the cockpit shows realistic, changing readings.
      const printing = [...this.jobs.values()].some(
        (j) => j.deviceId === p.id && !j.cancelled && !j.fail && !j.paused && j.polls >= 1 && j.polls < j.completeAfter + 1,
      );
      const temps = printing
        ? { nozzle: { actual: 215, target: 215 }, bed: { actual: 60, target: 60 } }
        : { nozzle: { actual: 24, target: 0 }, bed: { actual: 23, target: 0 } };
      return { ...p, temps };
    });
  }

  /** The connection's URL, as last built: read for what the printers run. */
  baseUrl: string | null = null;

  async readVersions(): Promise<Array<DeviceVersions & { deviceId: string }>> {
    const v = mockVersions(this.baseUrl);
    return Object.keys(v).length ? this.printers.map((p) => ({ deviceId: p.id, ...v })) : [];
  }

  async setDeviceEnabled(deviceId: string, enabled: boolean): Promise<void> {
    const p = this.printers.find((x) => x.id === deviceId);
    if (!p) throw new Error(`mock: no printer ${deviceId}`);
    p.enabled = enabled;
  }

  async uploadFile(_file: Uint8Array, filename: string): Promise<UploadResult> {
    const fileId = `f${++this.seq}`;
    this.files.set(fileId, { filename });
    return { fileId, filename };
  }

  /** Resolve a file's target from its filename convention (see header). */
  async resolvePlacement(fileId: string): Promise<PlacementResolution> {
    const f = this.files.get(fileId);
    if (!f) return { kind: "none", matchedName: null, deviceIds: [] };
    // Strip the gcode extension first so printer names with dots
    // ("Voron 2.4") survive, then take the @printer / #tag suffix.
    const base = f.filename.replace(/\.(gcode|bgcode|3mf)$/i, "");
    const at = base.indexOf("@");
    const hash = base.indexOf("#");
    if (at >= 0) return this.resolvePrinter(base.slice(at + 1).trim());
    if (hash >= 0) return this.resolveTag(base.slice(hash + 1).trim());
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  private resolvePrinter(name: string): PlacementResolution {
    const p = this.printers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return p
      ? { kind: "printer", matchedName: p.name, deviceIds: [p.id] }
      : { kind: "none", matchedName: null, deviceIds: [] };
  }

  private resolveTag(tag: string): PlacementResolution {
    const ids = this.printers.filter((p) => (p.tags ?? []).includes(tag)).map((p) => p.id);
    if (ids.length === 0) return { kind: "none", matchedName: null, deviceIds: [] };
    return { kind: "tag", matchedName: tag, deviceIds: ids };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    let deviceIds: string[];
    if (args.deviceId) deviceIds = [args.deviceId];
    else if (args.tag) deviceIds = this.resolveTag(args.tag).deviceIds;
    else deviceIds = (await this.resolvePlacement(args.fileId)).deviceIds;

    // Exactly one printer → queue it; otherwise await a manual pick.
    if (deviceIds.length === 1) {
      const jobId = `j${++this.seq}`;
      const fails = (this.files.get(args.fileId)?.filename ?? "").includes("[fails]");
      this.jobs.set(jobId, { jobId, deviceId: deviceIds[0]!, polls: 0, completeAfter: this.completeAfter, ...(fails ? { failAfter: 1 } : {}) });
      return { jobId, deviceId: deviceIds[0]!, queued: true, status: "queued" };
    }
    return { jobId: null, deviceId: null, queued: false, status: "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`mock: no job ${jobId}`);
    if (job.cancelled) return { jobId, state: "cancelled", progress: null, deviceId: job.deviceId };
    if (job.failAfter != null && job.polls >= job.failAfter) job.fail = true;
    if (job.fail) return { jobId, state: "failed", progress: null, deviceId: job.deviceId };
    // A paused job holds — it doesn't advance toward completion until resumed.
    if (job.paused) {
      return { jobId, state: "paused", progress: Math.min(1, job.polls / (job.completeAfter + 1)), deviceId: job.deviceId };
    }
    job.polls += 1;
    let state: JobStatus["state"];
    if (job.polls >= job.completeAfter + 1) state = "completed";
    else if (job.polls >= 1) state = "printing";
    else state = "queued";
    const progress = Math.min(1, job.polls / (job.completeAfter + 1));
    // Fake a ~2h print so the notification ETA/elapsed look realistic.
    const TOTAL = 7200;
    return {
      jobId,
      state,
      progress,
      deviceId: job.deviceId,
      elapsedSec: Math.round(progress * TOTAL),
      timeRemainingSec: Math.round((1 - progress) * TOTAL),
    };
  }

  /** Test helper: force a job to fail on next poll. */
  failJob(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (j) j.fail = true;
  }

  /** F-4: abort a job (the mock can stop a "print"). */
  async cancelJob(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) j.cancelled = true;
  }

  /** Cockpit live-control: pause / resume a running job. */
  async pauseJob(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) j.paused = true;
  }
  async resumeJob(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) j.paused = false;
  }

  /** ActuatorDriver: record the command + params so a test can assert the right
   *  zone/seconds reached the driver — no real valve. Always acks ok. */
  async runCommand(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    MOCK_COMMAND_LOG.push({ command, params });
    return { ok: true, ref: `mock:${command}` };
  }
}

export const mockFactory = (opts?: MockOptions) => new MockDriver(opts);
