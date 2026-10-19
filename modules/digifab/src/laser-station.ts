import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import type { JobApproval, JobReview } from "./drivers/types.js";
import { ReviewRequired } from "./drivers/job-review.js";
import { familyOfReviewKind } from "./core/families.js";
import { LaserMaterialSchema, materialFromFields, materialMismatch, preparedSheetAreaMismatch } from "./laser-material.js";

import { layoutOf, layoutMismatch, libraryForJob, laserBed } from "./sheet-layout.js";

const permits = new WeakSet<object>();
export interface StationPermit { readonly fileId: string; readonly projectHash: string }
export function hasStationPermit(permit: StationPermit | undefined, approval: JobApproval): boolean {
  return !!permit && permits.has(permit) && permit.fileId === approval.fileId && permit.projectHash === approval.projectHash;
}
export const stationTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function requireLaserBedReady(db: Kysely<DigifabDB>, job: Pick<Selectable<DigifabDB["digifab_jobs"]>, "id" | "connection_id" | "target_device">): Promise<void> {
  if (!job.connection_id || !job.target_device) throw new ReviewRequired("Choose one laser for this job first.");
  const attention = await db.selectFrom("digifab_device_attention").select("job_id").where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).executeTakeFirst();
  if (attention) throw new ReviewRequired("Take out the pieces and record their outcome at the station before the next job.");
  const active = await db.selectFrom("digifab_jobs").select("id").where("connection_id", "=", job.connection_id).where("target_device", "=", job.target_device).where("id", "!=", job.id).where("status", "in", ["sent", "printing", "paused"]).executeTakeFirst();
  if (active) throw new ReviewRequired("This laser already has a job. Finish it at the station before loading another file.");
}

export async function authorizeLaserStart(db: Kysely<DigifabDB>, orgId: string, job: Pick<Selectable<DigifabDB["digifab_jobs"]>, "id" | "file_id" | "connection_id" | "target_device">, approval?: JobApproval, printReview?: JobReview): Promise<StationPermit> {
  if (!approval?.stationToken || !job.connection_id || !job.target_device) throw new ReviewRequired("Approve at the machine's station.");
  const station = await db.selectFrom("digifab_stations").select("id")
    .where("token_hash", "=", stationTokenHash(approval.stationToken))
    .where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device)
    .where("revoked_at", "is", null).executeTakeFirst();
  if (!station) throw new ReviewRequired("This screen is not approved for this machine. Approve at the machine's station.");
  await requireLaserBedReady(db, job);
  const familyStart = familyOfReviewKind(printReview?.project.kind)?.start;
  if (familyStart && printReview) {
    await familyStart.authorize({ db, orgId, job, approval, review: printReview, stationId: station.id });
    const permit = Object.freeze({ fileId: approval.fileId, projectHash: approval.projectHash });
    permits.add(permit);
    return permit;
  }
  if (printReview && ["snapmaker-print", "snapmaker-u1-print", "resin-print", "ipp-print"].includes(String(printReview.project.kind))) {
    if (printReview.fileId !== approval.fileId || printReview.projectHash !== approval.projectHash) throw new ReviewRequired("The print file or toolhead changed. Review this print again.");
    const permit = Object.freeze({ fileId: approval.fileId, projectHash: approval.projectHash });
    permits.add(permit);
    return permit;
  }
  if (!approval.sheetId) throw new ReviewRequired("Confirm the loaded sheet at the laser's station.");
  const queued = await db.selectFrom("digifab_jobs").select(["run_id", "laser_layout"]).where("id", "=", job.id).executeTakeFirst();
  const library = await libraryForJob(db, { file_id: job.file_id, laser_layout: queued?.laser_layout });
  if (library?.kind !== "lbrn2" && library?.kind !== "laser-plan") throw new ReviewRequired("Choose a prepared laser file from the library for this station.");
  const required = LaserMaterialSchema.safeParse(library.metadata.laser_material);
  if (!required.success) throw new ReviewRequired("Save this file's material, thickness and sheet size before Start.");
  const sheet = await platform().entities.lookup(orgId, "inventory:part", approval.sheetId);
  const actual = sheet && !sheet.retired ? materialFromFields(sheet.fields) : null;
  if (!actual || Number(sheet?.fields.qty ?? 0) <= 0) throw new ReviewRequired("Choose an available sheet with saved material, thickness and dimensions.");
  const reason = materialMismatch(required.data, actual);
  if (reason) throw new ReviewRequired(reason);
  const layout = queued?.laser_layout ?? layoutOf(library.metadata);
  const areaReason = layout ? layoutMismatch(layout, approval.sheetId, sheet!.fields.sheet_geometry as { revision?: number; free_rectangles?: import("./laser-layout.js").Rect[] }) : preparedSheetAreaMismatch(required.data, sheet!.fields);
  if (layout) {
    const claim = await db.selectFrom("digifab_laser_sheet_claims").select("plan_id").where("part_id", "=", layout.sheet_id).where("plan_id", "=", layout.plan_id).executeTakeFirst();
    const plan = await db.selectFrom("digifab_laser_plans").select("run_id").where("id", "=", layout.plan_id).executeTakeFirst();
    const run = plan?.run_id ? await db.selectFrom("digifab_production_runs").select("status").where("id", "=", plan.run_id).executeTakeFirst() : null;
    if (!queued?.laser_layout || queued.run_id !== plan?.run_id || queued.laser_layout.content_hash !== layout.content_hash) throw new ReviewRequired("Use the original queued layout for this production run.");
    if (!claim || run?.status !== "active") throw new ReviewRequired("This layout's run is paused, cancelled or no longer owns its sheet.");
  }
  if (!layout) {
    const reserved = await db.selectFrom("digifab_laser_sheet_claims").select("plan_id").where("part_id", "=", approval.sheetId).executeTakeFirst();
    if (reserved) throw new ReviewRequired("This sheet is reserved for a laser batch. Use its queued sheet job.");
  }
  if (library.kind === "laser-plan" && layout) {
    const bed = await laserBed(db, orgId, job.connection_id, job.target_device);
    if (layout.footprints.some(r => r.x < 0 || r.y < 0 || r.x + r.width > bed.width || r.y + r.height > bed.height)) throw new ReviewRequired("The job no longer fits the saved laser bed. Make a new plan before Start.");
  }
  if (areaReason) throw new ReviewRequired(areaReason);
  const permit = Object.freeze({ fileId: approval.fileId, projectHash: approval.projectHash });
  permits.add(permit);
  return permit;
}
