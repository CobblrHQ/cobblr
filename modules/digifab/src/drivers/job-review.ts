import { createHash } from "node:crypto";
import { CncApprovalSchema } from "@cobblr/platform-contract/cnc";
import { z } from "zod";
import type { MachineDriver, SubmitArgs } from "./types.js";
import { CutterChecksSchema } from "../cutter-checks.js";
import { hasCutterPermit } from "../cutter-station.js";
import { hasStationPermit, type StationPermit } from "../laser-station.js";

export const JobApprovalSchema = z.object({ fileId: z.string().min(1).max(1000), projectHash: z.string().min(1).max(128), stationToken: z.string().min(32).max(128).optional(), sheetId: z.string().uuid().optional(), cnc: CncApprovalSchema.optional(), cutterChecks: CutterChecksSchema.optional() });
export class ReviewRequired extends Error {}
export class InterruptedStart extends ReviewRequired {
 constructor(message:string,readonly remoteJobId:string){super(message);}
}

function hasSpindleOrToolChange(bytes: Uint8Array): boolean {
  let comments = 0, lineComment = false, readingM = false, negative = false, sign = false, digits = false, dot = false, value = 0, fraction = 1;
  const dangerous = () => readingM && digits && !negative && [3, 4, 6].includes(value);
  for (const byte of bytes) {
    if (lineComment) { if (byte !== 10 && byte !== 13) continue; lineComment = false; }
    if (byte === 40) { comments = 1; continue; }
    if (comments) { if (byte === 41) comments--; continue; }
    if (byte === 59) { lineComment = true; continue; }
    if (readingM) {
      if (!digits && !dot && !sign && [9, 10, 13, 32].includes(byte)) continue;
      if (!digits && !dot && !sign && (byte === 43 || byte === 45)) { sign = true; negative = byte === 45; continue; }
      if (byte >= 48 && byte <= 57) {
        digits = true;
        if (dot) { fraction *= 0.1; value += (byte - 48) * fraction; }
        else value = value * 10 + byte - 48;
        continue;
      }
      if (byte === 46 && !dot) { dot = true; continue; }
      if (dangerous()) return true;
      readingM = false;
    }
    if (byte === 77 || byte === 109) { readingM = true; negative = false; sign = false; digits = false; dot = false; value = 0; fraction = 1; }
  }
  return dangerous();
}

export async function submitReviewedJob(driver: MachineDriver, bytes: Uint8Array, filename: string, args: Omit<SubmitArgs, "fileId">, stationPermit?: StationPermit) {
  const posted = /\.(nc|tap)$/i.test(filename) || /\.(gcode|gco|g)$/i.test(filename) && hasSpindleOrToolChange(bytes);
  if (posted && await driver.jobReviewKind?.() !== "cnc") throw new ReviewRequired("Choose a CNC station connection for this posted program. It cannot start through an unreviewed connector.");
  if (await driver.jobReviewRequired?.()) {
    if (!args.approval || !driver.getJobReview) throw new ReviewRequired("Review this job's project settings and approve Start first.");
    if (!args.checkStartAllowed) throw new ReviewRequired("Approve at the machine's station.");
    if (!(await driver.jobReviewKind?.() === "cutter" ? hasCutterPermit(stationPermit, args.approval) : hasStationPermit(stationPermit, args.approval))) throw new ReviewRequired("Approve at the machine's station.");
    const review = await driver.getJobReview(args.approval.fileId);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (review.contentHash !== contentHash || review.projectHash !== args.approval.projectHash) throw new ReviewRequired("The file or project settings changed. Review this job again before Start.");
    const up = { fileId: review.fileId, filename };
    await args.checkStartAllowed?.();
    return { up, sub: await driver.submitJob({ ...args, fileId: up.fileId, approval: { fileId: review.fileId, projectHash: review.projectHash } }) };
  }
  const up = await driver.uploadFile(bytes, filename);
  return { up, sub: await driver.submitJob({ ...args, fileId: up.fileId }) };
}
