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

import type {
  CommandResult,
  ConnectionResult,
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
}

export interface MockOptions {
  printers?: MockPrinter[];
  /** Polls until a queued job reads "completed" (default 2). */
  completeAfter?: number;
}

const DEFAULT_PRINTERS: MockPrinter[] = [
  { id: "p1", name: "Voron 2.4", enabled: true, state: "operational", tags: ["corexy", "pla"] },
  { id: "p2", name: "Prusa MK4", enabled: true, state: "operational", tags: ["pla"] },
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
    return this.printers.map((p) => ({ ...p }));
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
      this.jobs.set(jobId, { jobId, deviceId: deviceIds[0]!, polls: 0, completeAfter: this.completeAfter });
      return { jobId, deviceId: deviceIds[0]!, queued: true, status: "queued" };
    }
    return { jobId: null, deviceId: null, queued: false, status: "awaiting-assignment" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`mock: no job ${jobId}`);
    job.polls += 1;
    let state: JobStatus["state"];
    if (job.fail) state = "failed";
    else if (job.polls >= job.completeAfter + 1) state = "completed";
    else if (job.polls >= 1) state = "printing";
    else state = "queued";
    const progress = job.fail ? null : Math.min(1, job.polls / (job.completeAfter + 1));
    return { jobId, state, progress, deviceId: job.deviceId };
  }

  /** Test helper: force a job to fail on next poll. */
  failJob(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (j) j.fail = true;
  }

  /** ActuatorDriver: record the command + params so a test can assert the right
   *  zone/seconds reached the driver — no real valve. Always acks ok. */
  async runCommand(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    MOCK_COMMAND_LOG.push({ command, params });
    return { ok: true, ref: `mock:${command}` };
  }
}

export const mockFactory = (opts?: MockOptions) => new MockDriver(opts);
