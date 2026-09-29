// The farm watchdog: jobs keep moving across an api restart, a crash, or a
// queue job that ran out of attempts.
//
// Every live job rides a self-re-enqueuing queue chain (a poll chain per sent
// job, one assign chain per workspace with pool work). A chain that dies, or a
// process that stops half way through a send, used to leave a job where it
// was until somebody opened the queue page (the list route was the only
// place that revived a poll chain, and nothing revived an assign chain or a
// job stuck mid-send). This pass does that on a timer instead, for every
// workspace with farm work.
//
// The first round after the process starts visits every workspace with
// digifab on, since a restart forgets which had work; after that only the
// ones this process has seen work in.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { POLL_QUEUE, enqueuePoll } from "./poll-worker.js";
import { ASSIGN_QUEUE, kickAssign } from "./assign-worker.js";
import { farmActiveOrgs, farmIdle, noteFarmActive } from "./farm-active.js";

export const FARM_WATCHDOG_PASS = "digifab.farm-watchdog";
const EVERY_MS = 2 * 60_000;
/** Longer than the slowest send (a 120 s upload plus the submit), so a send
 *  still in flight is never taken for a stuck one. */
export const STUCK_SENDING_MS = 5 * 60_000;
const LIVE = ["sent", "printing", "paused", "awaiting-assignment"];

export interface FarmHeal {
  /** Jobs a stopped send left in `assigning`, put back in the queue. */
  requeued: number;
  /** Jobs a stopped send left in `assigning` after the printer took them, moved on to `sent`. */
  resumed: number;
  /** Live jobs whose poll chain had died, polled again. */
  repolled: number;
  /** An assign chain restarted for queued pool work. */
  assignKicked: boolean;
}

/** What to do with a job a send left in `assigning`: nothing yet while the
 *  send may still be running; `resume` it when the printer took it (only the
 *  status write was lost); `requeue` it when it never reached a printer. */
export function planStuckSend(j: { remote_job_id: string | null; updated_at: Date }, now: Date): "wait" | "resume" | "requeue" {
  if (now.getTime() - j.updated_at.getTime() < STUCK_SENDING_MS) return "wait";
  return j.remote_job_id ? "resume" : "requeue";
}

export async function healFarm(db: Kysely<DigifabDB>, orgId: string, now = new Date()): Promise<FarmHeal> {
  const out: FarmHeal = { requeued: 0, resumed: 0, repolled: 0, assignKicked: false };
  const cutoff = new Date(now.getTime() - STUCK_SENDING_MS);

  const stuck = await db
    .selectFrom("digifab_jobs")
    .select(["id", "remote_job_id", "target_pool", "sent_at", "updated_at"])
    .where("status", "=", "assigning")
    .where("updated_at", "<", cutoff)
    .execute();
  for (const j of stuck) {
    const plan = planStuckSend(j, now);
    if (plan === "wait") continue;
    if (plan === "resume") {
      // The printer took it; only the status write was lost. Polling decides the rest.
      const r = await db
        .updateTable("digifab_jobs")
        .set({ status: "sent", sent_at: j.sent_at ?? now, updated_at: now })
        .where("id", "=", j.id)
        .where("status", "=", "assigning")
        .executeTakeFirst();
      if (Number(r.numUpdatedRows ?? 0n) > 0) {
        out.resumed++;
        await enqueuePoll(orgId, j.id);
      }
      continue;
    }
    // Never reached a printer. Back to the queue with no printer attached: the
    // assign pass only sends to a printer that reports idle, so if the file did
    // start there after all, that printer reads busy and is not sent it twice.
    const r = await db
      .updateTable("digifab_jobs")
      .set({
        status: "queued",
        ...(j.target_pool ? { connection_id: null, target_device: null } : {}),
        error: "Cobblr stopped while sending this job, so it went back to the queue.",
        updated_at: now,
      })
      .where("id", "=", j.id)
      .where("status", "=", "assigning")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows ?? 0n) > 0) out.requeued++;
  }

  // A chain is alive when its next run is QUEUED. A "running" row can belong
  // to a process that was killed mid-run and will never finish it; an extra
  // pass beside a live one is harmless (every send and every finish is a
  // guarded claim), a missing one strands the work.
  const live = await db
    .selectFrom("digifab_jobs")
    .select("id")
    .where("status", "in", LIVE)
    .where("remote_job_id", "is not", null)
    .execute();
  if (live.length) {
    const pending = await platform().queue.hasPendingJob({ orgIds: [orgId], queue: POLL_QUEUE, statuses: ["queued"] });
    if (!pending.has(orgId)) {
      for (const j of live) await enqueuePoll(orgId, j.id);
      out.repolled = live.length;
    }
  }

  const poolWork = await db
    .selectFrom("digifab_jobs")
    .select("id")
    .where("status", "=", "queued")
    .where("target_pool", "is not", null)
    .limit(1)
    .executeTakeFirst();
  const activeRun = await db
    .selectFrom("digifab_production_runs")
    .select("id")
    .where("status", "=", "active")
    .limit(1)
    .executeTakeFirst();
  if (poolWork || activeRun || out.requeued > 0) {
    const pending = await platform().queue.hasPendingJob({ orgIds: [orgId], queue: ASSIGN_QUEUE, statuses: ["queued"] });
    if (!pending.has(orgId)) {
      await kickAssign(orgId);
      out.assignKicked = true;
    }
  }

  // A send still inside its window is work too: it has to be looked at again
  // once the window passes, so the workspace stays on the watch list.
  const sending = await db.selectFrom("digifab_jobs").select("id").where("status", "=", "assigning").limit(1).executeTakeFirst();
  if (live.length || poolWork || activeRun || sending) noteFarmActive(orgId);
  else farmIdle(orgId);
  return out;
}

let registered = false;

export function registerFarmWatchdog(): void {
  if (registered) return;
  registered = true;
  let firstRound = true;
  platform().sweeps.register({
    name: FARM_WATCHDOG_PASS,
    everyMs: EVERY_MS,
    firstAfterMs: 60_000,
    module: "digifab",
    candidates: async (orgIds) => {
      if (firstRound) {
        firstRound = false;
        return null;
      }
      const inScope = new Set(orgIds);
      return farmActiveOrgs().filter((o) => inScope.has(o));
    },
    visit: async ({ orgId, db, now }) => {
      const r = await healFarm(db as Kysely<DigifabDB>, orgId, now);
      if (r.requeued || r.resumed || r.repolled || r.assignKicked) {
        console.log(`[digifab] farm watchdog org ${orgId}: requeued ${r.requeued}, resumed ${r.resumed}, repolled ${r.repolled}${r.assignKicked ? ", assign restarted" : ""}`);
      }
    },
  });
}
