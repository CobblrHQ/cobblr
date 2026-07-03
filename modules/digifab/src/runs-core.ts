// Production runs — the quantity-driven scheduler ("make 250, stop when done").
//
// A run doesn't dispatch anything itself: it MINTS ordinary queued pool jobs up
// to the over-dispatch ceiling, and the existing assign worker / bed-clear gate
// / reprint-on-fail machinery runs them unchanged. Two entry points:
//
//   mintRunJobs()      — called at the top of every assign pass. For each
//                        active run: jobs_needed = ceil((target-completed)/ppp)
//                        minus the jobs already covering the run; insert that
//                        many queued pool jobs.
//   recordRunVerdict() — called from the bed-clear verdict route. `good`
//                        increments completed_qty by parts_per_plate (and
//                        closes the run at target, cancelling still-queued
//                        siblings); `scrapped` marks the job non-covering so
//                        the next pass mints a replacement.
//
// "Covering" is verdict-aware: a job counts toward the ceiling while it's
// non-terminal OR completed-but-unverdicted (run_outcome null). A scrapped or
// terminally-failed/cancelled plate stops covering, so the ceiling math
// replaces it automatically — no separate retry bookkeeping.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

/** States that cover a run's remaining quantity (see header). */
const COVERING_NON_TERMINAL = ["queued", "assigning", "sent", "printing", "awaiting-assignment"];

export type RunRow = {
  id: string;
  name: string;
  pool_id: string;
  file_id: string | null;
  file_ref: string;
  parts_per_plate: number;
  target_qty: number;
  completed_qty: number;
  status: string;
  material_part_id: string | null;
  material_grams: string | null;
  linked_build_id: string | null;
  build_qty: number;
  priority: number;
};

/** Jobs currently covering each of the given runs (verdict-aware). */
async function coveringCounts(db: Kysely<DigifabDB>, runIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!runIds.length) return counts;
  const rows = await db
    .selectFrom("digifab_jobs")
    .select(["run_id", "status", "run_outcome"])
    .where("run_id", "in", runIds)
    .execute();
  for (const r of rows) {
    if (!r.run_id) continue;
    const covers =
      COVERING_NON_TERMINAL.includes(r.status) || (r.status === "completed" && r.run_outcome == null);
    if (covers) counts.set(r.run_id, (counts.get(r.run_id) ?? 0) + 1);
  }
  return counts;
}

/** Mint queued pool jobs for every active run, up to the over-dispatch ceiling.
 *  Returns how many jobs were minted (callers only need it for logging/tests). */
export async function mintRunJobs(db: Kysely<DigifabDB>, _orgId: string): Promise<number> {
  const runs = (await db
    .selectFrom("digifab_production_runs")
    .selectAll()
    .where("status", "=", "active")
    .execute()) as RunRow[];
  if (!runs.length) return 0;

  const covering = await coveringCounts(
    db,
    runs.map((r) => r.id),
  );

  let minted = 0;
  for (const run of runs) {
    const ppp = Math.max(1, run.parts_per_plate);
    const remaining = run.target_qty - run.completed_qty;
    if (remaining <= 0) continue; // closed at verdict time; belt-and-braces
    const needed = Math.ceil(remaining / ppp) - (covering.get(run.id) ?? 0);
    for (let i = 0; i < needed; i++) {
      await db
        .insertInto("digifab_jobs")
        .values({
          file_ref: run.file_ref,
          file_id: run.file_id,
          target_pool: run.pool_id,
          run_id: run.id,
          status: "queued",
          priority: run.priority,
          material_part_id: run.material_part_id,
          material_grams: run.material_grams,
          linked_build_id: run.linked_build_id,
          build_qty: run.build_qty,
        })
        .execute();
      minted++;
    }
  }
  return minted;
}

/** Statuses of the runs behind a set of queued jobs — the assign pass uses this
 *  to skip jobs whose run is paused (they stay queued, nothing dispatches). */
export async function runStatuses(db: Kysely<DigifabDB>, runIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!runIds.length) return m;
  const rows = await db
    .selectFrom("digifab_production_runs")
    .select(["id", "status"])
    .where("id", "in", runIds)
    .execute();
  for (const r of rows) m.set(r.id, r.status);
  return m;
}

export type RunVerdictResult = { counted: boolean; runCompleted: boolean } | null;

/** Apply a bed-clear verdict to the job's run (no-op for run-less jobs).
 *  good → completed_qty += ppp, close at target (cancel queued siblings, emit
 *  digifab.run.completed). scrapped → mark the plate non-covering so the next
 *  assign pass mints a replacement. Idempotent per job via run_outcome. */
export async function recordRunVerdict(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  outcome: "good" | "scrapped",
): Promise<RunVerdictResult> {
  const job = await db
    .selectFrom("digifab_jobs")
    .select(["id", "run_id", "run_outcome"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job?.run_id) return null;

  // null→outcome atomic flip: double-submitting the verdict form (or a retried
  // request) must not double-count a plate.
  const claim = await db
    .updateTable("digifab_jobs")
    .set({ run_outcome: outcome === "good" ? "counted" : "scrapped", updated_at: new Date() })
    .where("id", "=", jobId)
    .where("run_outcome", "is", null)
    .executeTakeFirst();
  if (Number(claim.numUpdatedRows ?? 0n) === 0) return { counted: false, runCompleted: false };
  if (outcome === "scrapped") return { counted: false, runCompleted: false };

  const run = (await db
    .selectFrom("digifab_production_runs")
    .selectAll()
    .where("id", "=", job.run_id)
    .executeTakeFirst()) as RunRow | undefined;
  if (!run) return { counted: false, runCompleted: false };

  const ppp = Math.max(1, run.parts_per_plate);
  const newCompleted = run.completed_qty + ppp;
  const done = newCompleted >= run.target_qty && run.status !== "completed";
  await db
    .updateTable("digifab_production_runs")
    .set({ completed_qty: newCompleted, ...(done ? { status: "completed" } : {}), updated_at: new Date() })
    .where("id", "=", run.id)
    .execute();

  if (done) {
    // Cancel plates that never left the queue — in-flight ones finish normally
    // (their good verdicts may overshoot completed_qty past target; honest ledger).
    await db
      .updateTable("digifab_jobs")
      .set({ status: "cancelled", error: "production run reached its target", updated_at: new Date() })
      .where("run_id", "=", run.id)
      .where("status", "=", "queued")
      .execute();
    void platform().events.emit("digifab.run.completed", {
      orgId,
      runId: run.id,
      name: run.name,
      targetQty: run.target_qty,
      completedQty: newCompleted,
      linkedBuildId: run.linked_build_id,
    });
  }
  return { counted: true, runCompleted: done };
}
