// A good build output is counted as made once, and never lost on the way.
//
// A verdict of good on a build-linked job whose output was deferred owes the
// build's output part a credit. The credit is applied by the builds wire
// (digifab.job.build_output → builds:credit-output), which can fail without
// the verdict knowing: the event bus swallows a wire's error. So the job is
// stamped build_output_at only when builds says it applied the credit
// (builds.output.credited), and until then the output is pending: a verdict
// recorded again, and a sweep, ask again. builds applies it once per job, so
// asking twice never counts it twice.
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

/** Ask for a job's output credit when its good output is still unconfirmed. True when asked. */
export async function creditPendingOutput(db: Kysely<DigifabDB>, orgId: string, jobId: string): Promise<boolean> {
  const job = await db
    .selectFrom("digifab_jobs")
    .select(["linked_build_id", "build_consumed_at", "build_reversed_at", "build_output_deferred", "build_output_at", "outcome_good_qty"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  const good = Number(job?.outcome_good_qty ?? 0);
  if (!job?.linked_build_id || !job.build_consumed_at || job.build_reversed_at || !job.build_output_deferred || job.build_output_at || !(good > 0)) return false;
  // Awaited: whoever gave the verdict re-reads stock the moment it answers.
  await platform().events.emit("digifab.job.build_output", { orgId, jobId, buildId: job.linked_build_id, qty: good });
  return true;
}

export function registerOutputCredit(): void {
  platform().events.on("builds.output.credited", "digifab", async (payload: unknown) => {
    const { orgId, jobId } = (payload ?? {}) as { orgId?: string; jobId?: string };
    if (!orgId || !jobId) return;
    const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
    await db.updateTable("digifab_jobs").set({ build_output_at: new Date(), updated_at: new Date() }).where("id", "=", jobId).where("build_output_at", "is", null).execute();
  });
  platform().sweeps.register({
    name: "digifab.output-credit", module: "digifab", everyMs: 10 * 60_000, firstAfterMs: 60_000,
    visit: async ({ orgId, db }) => {
      const tdb = db as Kysely<DigifabDB>;
      // A verdict at least a minute old whose good output builds has not confirmed.
      const pending = await tdb.selectFrom("digifab_jobs").select("id")
        .where("build_output_deferred", "=", true).where("build_output_at", "is", null)
        .where("build_consumed_at", "is not", null).where("build_reversed_at", "is", null)
        .where("linked_build_id", "is not", null).where(sql<boolean>`coalesce(outcome_good_qty, 0) > 0`)
        .where("outcome_at", "<", new Date(Date.now() - 60_000))
        // list-cap-ok: a sweep pass asks again for at most this many; the rest wait for the next pass
        .limit(50).execute();
      for (const row of pending) await creditPendingOutput(tdb, orgId, row.id);
    },
  });
}
