// Cross-machine queue — the assignment worker. A job that targets a POOL is
// created unassigned (no connection, no device); this worker drips queued pool
// jobs onto FREE member devices as printers come idle, then hands each off to
// the normal send + poll path. Coordinate-not-control at fleet scale: it only
// picks which manager+printer gets the file.
//
// Self-pacing: a pass that leaves jobs queued re-enqueues a tick in 15s, so a
// printer that frees up pulls the next job within a tick; an empty queue stops
// the loop. `kickAssign` fires an immediate pass on job-create.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { buildDriverById, sendJob } from "./jobs-core.js";
import { enqueuePoll } from "./poll-worker.js";
import { classify } from "./state.js";
import type { RemoteDevice } from "./drivers/types.js";

export const ASSIGN_QUEUE = "digifab.assign";
const ASSIGN_INTERVAL_MS = 15_000;

let registered = false;

export function registerAssignWorker(): void {
  if (registered) return;
  registered = true;
  platform().queue.registerWorker(ASSIGN_QUEUE, async (job) => {
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<DigifabDB>;
    const stillQueued = await assignPoolJobs(db, job.orgId);
    if (stillQueued > 0) {
      await platform().queue.enqueue({
        orgId: job.orgId,
        queue: ASSIGN_QUEUE,
        payload: {},
        runAt: new Date(Date.now() + ASSIGN_INTERVAL_MS),
      });
    }
  });
}

/** Fire an immediate assignment pass for an org (on pool-job create). */
export async function kickAssign(orgId: string): Promise<void> {
  await platform().queue.enqueue({ orgId, queue: ASSIGN_QUEUE, payload: {}, runAt: new Date() });
}

/** One assignment pass: drip queued pool jobs onto free member devices.
 *  Returns how many remain queued (so the worker knows whether to re-tick). */
export async function assignPoolJobs(db: Kysely<DigifabDB>, orgId: string): Promise<number> {
  const queued = await db
    .selectFrom("digifab_jobs")
    .selectAll()
    .where("status", "=", "queued")
    .where("target_pool", "is not", null)
    .orderBy("priority", "desc")
    .orderBy("created_at", "asc")
    .execute();
  if (!queued.length) return 0;

  // Devices already busy with an assigned Cobblr job.
  const active = await db
    .selectFrom("digifab_jobs")
    .select(["connection_id", "target_device"])
    .where("status", "in", ["sent", "printing"])
    .execute();
  const busy = new Set(
    active.filter((a) => a.connection_id && a.target_device).map((a) => `${a.connection_id}:${a.target_device}`),
  );

  // F-1: devices awaiting a human bed-clear ack — NEVER assign onto an occupied
  // bed. (classify() already excludes manager-reported complete/paused; this
  // catches the case where the manager has returned to idle but the part is
  // still on the bed.) A human clears the row via POST …/ready.
  const attention = new Set(
    (await db.selectFrom("digifab_device_attention").select(["connection_id", "remote_device_id"]).execute()).map(
      (a) => `${a.connection_id}:${a.remote_device_id}`,
    ),
  );

  // F-3: surface an assignment send-failure instead of swallowing it.
  const failJob = (id: string, msg: string) =>
    db.updateTable("digifab_jobs").set({ status: "failed", error: msg.slice(0, 300), updated_at: new Date() }).where("id", "=", id).execute();

  // Cache listDevices per connection for the pass (null = unreachable).
  const deviceCache = new Map<string, RemoteDevice[] | null>();
  async function devicesFor(connId: string): Promise<RemoteDevice[]> {
    if (deviceCache.has(connId)) return deviceCache.get(connId) ?? [];
    let devs: RemoteDevice[] | null = null;
    try {
      const drv = await buildDriverById(db, orgId, connId);
      devs = drv ? await drv.listDevices() : null;
    } catch {
      devs = null;
    }
    deviceCache.set(connId, devs);
    return devs ?? [];
  }

  let stillQueued = 0;
  for (const job of queued) {
    if (!job.target_pool) continue;
    const members = await db
      .selectFrom("digifab_pool_members")
      .select(["connection_id", "remote_device_id", "loaded_material"])
      .where("pool_id", "=", job.target_pool)
      .execute();

    // "resolved" = this job either got SENT or got marked FAILED this pass —
    // either way it's off the queue. Only a job that found NO free device stays
    // queued and re-ticks. (Pre-F-3 this conflated a swallowed send-failure with
    // a successful assignment.)
    let resolved = false;
    for (const m of members) {
      const key = `${m.connection_id}:${m.remote_device_id}`;
      if (busy.has(key) || attention.has(key)) continue; // F-1: skip occupied/uncleared
      const dev = (await devicesFor(m.connection_id)).find((d) => d.id === m.remote_device_id);
      if (!dev || !dev.enabled || classify(dev.state ?? "") !== "idle") continue;

      // Assign: stamp the connection + device, then send through the shared path.
      // Status-guarded CLAIM — two overlapping passes (a slow tick overrunning the
      // next, or kickAssign racing the 15s re-tick) both read the same `queued`
      // job; only the pass that flips queued→assigning owns it. The loser skips,
      // so one job can never be physically sent to two printers.
      const claim = await db
        .updateTable("digifab_jobs")
        .set({ connection_id: m.connection_id, target_device: m.remote_device_id, status: "assigning", updated_at: new Date() })
        .where("id", "=", job.id)
        .where("status", "=", "queued")
        .executeTakeFirst();
      if (Number(claim.numUpdatedRows ?? 0n) === 0) {
        resolved = true; // another pass owns it
        break;
      }
      // The job rides through sendJob as `assigning` (not terminal, so sendJob
      // accepts it; not `queued`, so no concurrent pass can re-claim it). sendJob
      // flips it to sent/awaiting-assignment; a failure path marks it failed.
      // F-3: a send that returns {ok:false} OR throws must be surfaced on the job
      // (status:failed + error), NOT silently treated as "assigned" — and a throw
      // must not reject the whole pass and stall every other queued job.
      try {
        const r = await sendJob(db, orgId, job.id);
        if (r.ok) {
          if (r.shouldPoll) await enqueuePoll(orgId, job.id);
          busy.add(key);
        } else {
          await failJob(job.id, `pool assignment send failed: ${r.code}`);
        }
      } catch (e) {
        await failJob(job.id, `pool assignment send error: ${(e as Error).message}`);
      }
      resolved = true;
      break;
    }
    if (!resolved) stillQueued++;
  }
  return stillQueued;
}
