// Auto-poll — a core-queue worker that walks a sent job to its terminal
// state. On send the route enqueues one poll; this worker polls, and
// while the job is non-terminal re-enqueues itself for `runAt` later.
// No cron: just the queue's runAt + the kernel's worker loop.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreFarmDB } from "./db.js";
import { pollJob } from "./jobs-core.js";

export const POLL_QUEUE = "core-farm.poll";
// Poll cadence. Real farms are happy at ~60s; tighter here so a mock job
// (and the dev demo) reaches completed quickly.
const INTERVAL_MS = 4000;

let registered = false;

export function registerPollWorker(): void {
  if (registered) return;
  registered = true;
  platform().queue.registerWorker(POLL_QUEUE, async (job) => {
    const jobId = String((job.payload as { jobId?: unknown }).jobId ?? "");
    if (!jobId) return;
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<CoreFarmDB>;
    const res = await pollJob(db, job.orgId, jobId);
    if (res && !res.terminal) {
      await platform().queue.enqueue({
        orgId: job.orgId,
        queue: POLL_QUEUE,
        payload: { jobId },
        runAt: new Date(Date.now() + INTERVAL_MS),
      });
    }
  });
}

export async function enqueuePoll(orgId: string, jobId: string): Promise<void> {
  await platform().queue.enqueue({
    orgId,
    queue: POLL_QUEUE,
    payload: { jobId },
    runAt: new Date(Date.now() + INTERVAL_MS),
  });
}
