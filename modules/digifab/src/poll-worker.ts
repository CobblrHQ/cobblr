// Auto-poll — a core-queue worker that walks a sent job to its terminal
// state. On send the route enqueues one poll; this worker polls, and
// while the job is non-terminal re-enqueues itself for `runAt` later.
// No cron: just the queue's runAt + the kernel's worker loop.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { pollJob } from "./jobs-core.js";
import { ensureFailureWatch } from "./failure-detect.js";

export const POLL_QUEUE = "digifab.poll";
// First-poll delay after a send — quick for every driver so the queue shows
// "printing" promptly. Subsequent re-polls use the driver-aware interval that
// pollJob returns (mock 4s; real farms 30s — see pollTuning in jobs-core.ts).
const FIRST_POLL_MS = 4000;

let registered = false;

export function registerPollWorker(): void {
  if (registered) return;
  registered = true;
  platform().queue.registerWorker(POLL_QUEUE, async (job) => {
    const jobId = String((job.payload as { jobId?: unknown }).jobId ?? "");
    if (!jobId) return;
    // The poll chain is self-re-enqueuing: a THROW here (driver row uninstalled,
    // tenant db hiccup) used to burn the queue job's 3 attempts and kill the
    // chain permanently — the job then sat in `sent`/`printing` forever with no
    // watchdog. Catch instead and keep the chain alive; pollJob's own F-12
    // error-threshold is what decides when to give up on an unreachable manager.
    let res: Awaited<ReturnType<typeof pollJob>> = null;
    try {
      const db = (await platform().tenants.getDb(job.orgId)) as Kysely<DigifabDB>;
      res = await pollJob(db, job.orgId, jobId);
      // A live print → make sure its AI failure watch is running (no-op when
      // detection is off, or a watch loop is already alive for the device).
      if (res?.status === "printing") {
        try {
          const row = await db.selectFrom("digifab_jobs").select(["connection_id", "target_device"]).where("id", "=", jobId).executeTakeFirst();
          if (row?.connection_id && row.target_device) await ensureFailureWatch(db, job.orgId, row.connection_id, row.target_device);
        } catch {
          /* watch is best-effort; never break the poll chain */
        }
      }
    } catch (e) {
      console.error(`[digifab] poll ${jobId} errored (chain continues):`, (e as Error).message);
      res = { status: "unknown", terminal: false, intervalMs: 30_000 };
    }
    if (res && !res.terminal) {
      await platform().queue.enqueue({
        orgId: job.orgId,
        queue: POLL_QUEUE,
        payload: { jobId },
        runAt: new Date(Date.now() + (res.intervalMs || FIRST_POLL_MS)),
      });
    }
  });
}

export async function enqueuePoll(orgId: string, jobId: string): Promise<void> {
  await platform().queue.enqueue({
    orgId,
    queue: POLL_QUEUE,
    payload: { jobId },
    runAt: new Date(Date.now() + FIRST_POLL_MS),
  });
}

/** Self-healing for dead poll chains. If this org has live (pollable) jobs but
 *  NOTHING pending on the poll queue, every chain has died (process crash burned
 *  the queue attempts, etc.) — re-enqueue one poll per live job. Called from the
 *  jobs list route: the UI refetches it every 5s while jobs are active, so a dead
 *  chain resurrects the moment anyone looks at the queue. Cheap when healthy
 *  (one indexed queue lookup, no-op). */
export async function reconcilePolls(
  orgId: string,
  liveJobIds: string[],
): Promise<void> {
  if (!liveJobIds.length) return;
  const pending = await platform().queue.hasPendingJob({ orgIds: [orgId], queue: POLL_QUEUE });
  if (pending.has(orgId)) return;
  for (const id of liveJobIds) await enqueuePoll(orgId, id);
}
