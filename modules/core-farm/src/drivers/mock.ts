// Mock farm driver — an in-memory FarmDriver that lets the WHOLE
// send→poll→completed pipeline be driven end-to-end with no hardware.
// Deterministic: a job advances queued → printing → completed by poll
// count (not wall-clock), so tests never sleep. Routing is honored so the
// tag / ambiguous / awaiting-assignment paths are exercised too.
//
// Routing convention for tests: a filename may encode its target —
//   "thing@Voron 2.4.gcode"  → routes to the printer named "Voron 2.4"
//   "thing#pla.gcode"        → routes to the tag "pla" (its printer set)
// resolvePlacement reads that; submitJob({printerId}|{tag}) overrides it.

import type {
  ConnectionResult,
  FarmDriver,
  JobStatus,
  PlacementResolution,
  RemotePrinter,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";

interface MockPrinter extends RemotePrinter {}
interface MockJob {
  jobId: string;
  printerId: string | null;
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

export class MockFarmDriver implements FarmDriver {
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

  async listPrinters(): Promise<RemotePrinter[]> {
    return this.printers.map((p) => ({ ...p }));
  }

  async setPrinterEnabled(printerId: string, enabled: boolean): Promise<void> {
    const p = this.printers.find((x) => x.id === printerId);
    if (!p) throw new Error(`mock: no printer ${printerId}`);
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
    if (!f) return { kind: "none", matchedName: null, printerIds: [] };
    // Strip the gcode extension first so printer names with dots
    // ("Voron 2.4") survive, then take the @printer / #tag suffix.
    const base = f.filename.replace(/\.(gcode|bgcode|3mf)$/i, "");
    const at = base.indexOf("@");
    const hash = base.indexOf("#");
    if (at >= 0) return this.resolvePrinter(base.slice(at + 1).trim());
    if (hash >= 0) return this.resolveTag(base.slice(hash + 1).trim());
    return { kind: "none", matchedName: null, printerIds: [] };
  }

  private resolvePrinter(name: string): PlacementResolution {
    const p = this.printers.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return p
      ? { kind: "printer", matchedName: p.name, printerIds: [p.id] }
      : { kind: "none", matchedName: null, printerIds: [] };
  }

  private resolveTag(tag: string): PlacementResolution {
    const ids = this.printers.filter((p) => (p.tags ?? []).includes(tag)).map((p) => p.id);
    if (ids.length === 0) return { kind: "none", matchedName: null, printerIds: [] };
    return { kind: "tag", matchedName: tag, printerIds: ids };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    let printerIds: string[];
    if (args.printerId) printerIds = [args.printerId];
    else if (args.tag) printerIds = this.resolveTag(args.tag).printerIds;
    else printerIds = (await this.resolvePlacement(args.fileId)).printerIds;

    // Exactly one printer → queue it; otherwise await a manual pick.
    if (printerIds.length === 1) {
      const jobId = `j${++this.seq}`;
      this.jobs.set(jobId, { jobId, printerId: printerIds[0]!, polls: 0, completeAfter: this.completeAfter });
      return { jobId, printerId: printerIds[0]!, queued: true, status: "queued" };
    }
    return { jobId: null, printerId: null, queued: false, status: "awaiting-assignment" };
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
    return { jobId, state, progress, printerId: job.printerId };
  }

  /** Test helper: force a job to fail on next poll. */
  failJob(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (j) j.fail = true;
  }
}

export const mockFactory = (opts?: MockOptions) => new MockFarmDriver(opts);
