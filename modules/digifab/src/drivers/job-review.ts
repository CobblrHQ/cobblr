import { createHash } from "node:crypto";
import { z } from "zod";
import type { MachineDriver, SubmitArgs } from "./types.js";

export const JobApprovalSchema = z.object({ fileId: z.string().min(1).max(1000), projectHash: z.string().min(1).max(128) });
export class ReviewRequired extends Error {}

export async function submitReviewedJob(driver: MachineDriver, bytes: Uint8Array, filename: string, args: Omit<SubmitArgs, "fileId">) {
  if (await driver.jobReviewRequired?.()) {
    if (!args.approval || !driver.getJobReview) throw new ReviewRequired("Review this job's project settings and approve Start first.");
    const review = await driver.getJobReview(args.approval.fileId);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (review.contentHash !== contentHash || review.projectHash !== args.approval.projectHash) throw new ReviewRequired("The file or project settings changed. Review this job again before Start.");
    const up = { fileId: review.fileId, filename };
    return { up, sub: await driver.submitJob({ ...args, fileId: up.fileId, approval: { fileId: review.fileId, projectHash: review.projectHash } }) };
  }
  const up = await driver.uploadFile(bytes, filename);
  return { up, sub: await driver.submitJob({ ...args, fileId: up.fileId }) };
}
