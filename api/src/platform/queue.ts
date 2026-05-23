// core-queue v0.1 — persistent background work.
//
// Public API:
//   enqueue({ orgId, queue, payload, runAt?, maxAttempts? }) → job id
//   registerWorker(queueName, handler)         — once per process
//   tick()                                       — one polling pass
//   startWorker()                                — kicks the 5s loop
//
// Pattern:
//   1. Modules call enqueue() to defer work.
//   2. Modules call registerWorker(name, fn) at boot to declare the
//      handler for jobs on that named queue.
//   3. A single setInterval-driven tick() in the api process pulls
//      ready jobs via SELECT FOR UPDATE SKIP LOCKED, locks each one,
//      runs the handler, then marks done OR schedules a retry with
//      exponential backoff.
//
// Locking is per-row via SKIP LOCKED so multiple api instances can
// race without colliding. A stale lock (locked_at > 15min) is
// treated as a crashed worker and the job is reclaimed automatically
// at the start of each tick.
//
// What this is NOT (yet):
//   - distributed coordination beyond SKIP LOCKED
//   - priority queues (FIFO within a named queue, run_at-ordered)
//   - dead-letter inspection UI (jobs stuck in 'failed' just sit)
//   - cron-style recurring jobs (core-recurrence is the right place
//     for that; a future iteration could wire scheduler → queue)

import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { meta } from "../db/meta.js";

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

// Max time we'll let a job hold its lock before we treat the worker
// as crashed and reclaim. 15min is generous for any reasonable
// handler; cron-style "every N minutes" jobs should be much shorter.
const STALE_LOCK_MS = 15 * 60 * 1000;

// Worker poll cadence. Tight enough that a just-enqueued job runs
// within a few seconds; loose enough that an idle queue doesn't burn
// CPU. Per-tick scan is two indexed queries + one UPDATE so this is
// fine.
const POLL_INTERVAL_MS = 5_000;

// Per-handler concurrency: how many jobs from one queue we'll claim
// in a single tick. Keep low so a slow handler can't starve other
// queues; multiple ticks give plenty of throughput.
const JOBS_PER_TICK = 5;

export type QueueHandler = (job: {
  id: string;
  orgId: string;
  payload: Record<string, unknown>;
  attempts: number;
}) => Promise<void> | void;

const handlers = new Map<string, QueueHandler>();

export interface EnqueueParams {
  orgId: string;
  queue: string;
  payload?: Record<string, unknown>;
  /** When to FIRST run the job. Default now (immediate). */
  runAt?: Date;
  /** Retry budget. Default 3. */
  maxAttempts?: number;
}

export async function enqueue(p: EnqueueParams): Promise<string> {
  const row = await meta
    .insertInto("core_queue_jobs")
    .values({
      org_id: p.orgId,
      queue: p.queue,
      payload: p.payload ?? {},
      run_at: (p.runAt ?? new Date()) as never,
      max_attempts: p.maxAttempts ?? 3,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export function registerWorker(queue: string, handler: QueueHandler): void {
  if (handlers.has(queue)) {
    console.warn(`[queue] replacing handler for ${queue}`);
  }
  handlers.set(queue, handler);
}

export function listQueues(): string[] {
  return Array.from(handlers.keys());
}

/** Reclaim stale locks (worker crashed mid-execution) so the next
 *  tick's claim can pick them up. Idempotent. */
async function sweepStaleLocks(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const reclaimed = await meta
    .updateTable("core_queue_jobs")
    .set({ status: "queued", locked_at: null, locked_by: null } as never)
    .where("status", "=", "running")
    .where("locked_at", "<", cutoff)
    .returning("id")
    .execute();
  return reclaimed.length;
}

/** Pop up to N ready jobs from one queue. Each row is locked via
 *  SKIP LOCKED + flipped to 'running' so the caller can release the
 *  meta connection before invoking the handler. Returns the locked
 *  rows. */
async function claim(
  queue: string,
  limit: number,
): Promise<
  Array<{ id: string; org_id: string; payload: Record<string, unknown>; attempts: number }>
> {
  const rows = await meta
    .updateTable("core_queue_jobs")
    .set({
      status: "running",
      locked_at: new Date(),
      locked_by: WORKER_ID,
    } as never)
    .where("id", "in", (eb) =>
      eb
        .selectFrom("core_queue_jobs")
        .select("id")
        .where("status", "=", "queued")
        .where("run_at", "<=", new Date())
        .where("queue", "=", queue)
        .orderBy("run_at", "asc")
        .limit(limit)
        .modifyEnd(sql`for update skip locked`),
    )
    .returning(["id", "org_id", "payload", "attempts"])
    .execute();
  return rows.map((r) => ({
    id: r.id,
    org_id: r.org_id,
    payload: (r.payload as Record<string, unknown>) ?? {},
    attempts: r.attempts,
  }));
}

async function markDone(id: string): Promise<void> {
  await meta
    .updateTable("core_queue_jobs")
    .set({
      status: "done",
      locked_at: null,
      locked_by: null,
      completed_at: new Date(),
    } as never)
    .where("id", "=", id)
    .execute();
}

async function markFailedOrRetry(
  id: string,
  attempts: number,
  maxAttempts: number,
  err: Error,
): Promise<"retried" | "failed"> {
  if (attempts + 1 >= maxAttempts) {
    await meta
      .updateTable("core_queue_jobs")
      .set({
        status: "failed",
        attempts: attempts + 1,
        locked_at: null,
        locked_by: null,
        failed_at: new Date(),
        error: err.message.slice(0, 2000),
      } as never)
      .where("id", "=", id)
      .execute();
    return "failed";
  }
  // Exponential backoff: 5s, 30s, 3m, 18m, ... bounded at 1h.
  const delaySec = Math.min(5 * 6 ** attempts, 3600);
  const nextRun = new Date(Date.now() + delaySec * 1000);
  await meta
    .updateTable("core_queue_jobs")
    .set({
      status: "queued",
      attempts: attempts + 1,
      locked_at: null,
      locked_by: null,
      run_at: nextRun as never,
      error: err.message.slice(0, 2000),
    } as never)
    .where("id", "=", id)
    .execute();
  return "retried";
}

export interface TickResult {
  ran: number;
  failed: number;
  retried: number;
  staleReclaimed: number;
}

/** One polling pass. Reclaims stale locks, then for each registered
 *  handler claims up to JOBS_PER_TICK ready jobs and invokes the
 *  handler. Errors per job are logged + retried; the loop never
 *  takes down the worker. */
export async function tick(): Promise<TickResult> {
  const staleReclaimed = await sweepStaleLocks();
  let ran = 0;
  let failed = 0;
  let retried = 0;

  // Fan out across queues in parallel: a slow handler on one queue
  // shouldn't block another queue's throughput.
  await Promise.all(
    Array.from(handlers.entries()).map(async ([queue, handler]) => {
      const jobs = await claim(queue, JOBS_PER_TICK);
      for (const job of jobs) {
        // We need max_attempts to decide retry vs. fail. Read it
        // alongside the claim to avoid an extra query — simplest
        // hack: read from a second SELECT now. Cheap; we just
        // claimed by id.
        const meta_row = await meta
          .selectFrom("core_queue_jobs")
          .select("max_attempts")
          .where("id", "=", job.id)
          .executeTakeFirstOrThrow();
        try {
          await handler({
            id: job.id,
            orgId: job.org_id,
            payload: job.payload,
            attempts: job.attempts,
          });
          await markDone(job.id);
          ran++;
        } catch (err) {
          const outcome = await markFailedOrRetry(
            job.id,
            job.attempts,
            meta_row.max_attempts,
            err as Error,
          );
          if (outcome === "failed") failed++;
          else retried++;
          console.error(
            `[queue:${queue}] job ${job.id} ${outcome}:`,
            (err as Error).message,
          );
        }
      }
    }),
  );

  return { ran, failed, retried, staleReclaimed };
}

let timer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

export function startWorker(): void {
  if (timer) return;
  stopping = false;
  async function loop() {
    if (stopping) return;
    try {
      await tick();
    } catch (err) {
      console.error("[queue] tick failed:", (err as Error).message);
    }
  }
  // Run an immediate first tick so freshly-enqueued jobs don't wait
  // POLL_INTERVAL_MS just because they happen to land between ticks.
  void loop();
  timer = setInterval(() => void loop(), POLL_INTERVAL_MS);
  console.log(
    `[queue] worker ${WORKER_ID} started — ticking every ${POLL_INTERVAL_MS / 1000}s`,
  );
}

export function stopWorker(): void {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
