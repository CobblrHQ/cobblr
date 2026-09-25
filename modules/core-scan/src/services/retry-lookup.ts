/** The server-side owner of "we will look this barcode up again".
 *
 *  A throttled catalog leaves an inbox row unresolved and the card said
 *  "Barcode service is rate-limited — retrying automatically in a moment."
 *  Nothing on the server was retrying. The only retry was a `setInterval` in a
 *  React effect: two attempts, fifteen seconds apart, alive only while that tab
 *  was open, its give-up state held in component state that a reload discarded.
 *  One reported row sat on that sentence for over an hour (2026-08-14).
 *
 *  So the promise gets an owner that outlives the tab. `core-queue` already
 *  provides exactly this and is used the same way by digifab's poll worker:
 *  persistent rows, `SELECT FOR UPDATE SKIP LOCKED` so several api instances can
 *  race safely, exponential backoff between attempts, and a stale-lock sweep for
 *  a worker that died holding one. No new table was needed, and building the
 *  `core_scan_intents` table this was specced as would have been a second, worse
 *  copy of it.
 *
 *  ONE DELIBERATE ASYMMETRY. The retry does not fire immediately. A rate-limit
 *  means the provider gate is closed right now, so the first attempt waits out
 *  the burst window rather than spending itself against a door that is still
 *  shut. */

import { platform } from "@cobblr/platform-contract";
import { LOOKUP_GAVE_UP } from "@cobblr/platform-contract/scan-copy";

export const RETRY_LOOKUP_QUEUE = "core-scan:retry-lookup";

/** Attempts before the row is told, honestly, that this is not resolving. */
export const RETRY_MAX_ATTEMPTS = 5;

/** How long to wait before the FIRST retry. Past the upcitemdb burst window,
 *  which is the throttle most scans actually hit. */
export const RETRY_FIRST_DELAY_MS = 60_000;

/** The wait before attempt n+2, after attempt n+1 ran and still could not
 *  answer: the chain's OWN schedule. It rode core-queue's global backoff
 *  (5 s, 30 s, 3 min, 18 min), so the fourth run said "attempt 5 of 5" and
 *  the fifth came eighteen minutes later; at a booth that read as a row stuck
 *  for good (#3710). The whole chain now ends inside RETRY_WINDOW_MS. */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 90_000, 120_000, 120_000];

/** How long, from the row's last write, a retry can honestly still be
 *  coming: the longest single wait, plus a slow lookup's own time and the
 *  queue's polling. The worker rewrites the row after every attempt, so a
 *  row still claiming a retry this long after its last write has nothing
 *  behind it (a lost job, a restart mid-chain) and is read as having run
 *  out. */
export const RETRY_WINDOW_MS = Math.max(RETRY_FIRST_DELAY_MS, ...RETRY_DELAYS_MS) + 5 * 60_000;

/** The wait before the run after attempt `attemptNo` (1-based). */
export function nextRetryDelayMs(attemptNo: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptNo - 1, 0), RETRY_DELAYS_MS.length - 1)]!;
}

/** Why the look-up is being retried. A catalog that said "too many requests"
 *  is busy; one that did not answer at all (a timeout, a refused key, down)
 *  could not be asked, and calling that "busy" sent the operator looking at
 *  a rate limit that was not there (#3710). */
export type RetryCause = "busy" | "unreachable";

export { LOOKUP_GAVE_UP };

/** What the row should SAY, given where the retry has got to.
 *
 *  The old sentence was written once and never revised, so it kept promising a
 *  retry long after the client had given up. Every state below is reachable and
 *  each one is the truth at that moment. */
export function retryNote(attempts: number, maxAttempts = RETRY_MAX_ATTEMPTS, cause: RetryCause = "busy"): string {
  if (attempts >= maxAttempts) return LOOKUP_GAVE_UP;
  const what = cause === "unreachable" ? "Couldn't reach the barcode service." : "Barcode service is busy.";
  if (attempts <= 0) return `${what} Trying again in a minute.`;
  return `${what} Trying again (attempt ${attempts + 1} of ${maxAttempts}).`;
}

/** Has this row's retry budget run out? */
export function retriesExhausted(attempts: number, maxAttempts = RETRY_MAX_ATTEMPTS): boolean {
  return attempts >= maxAttempts;
}

/** The worker's view of one run, from core-queue's `job.attempts`.
 *
 *  That field is the count of PRIOR attempts — the column starts at 0 and is
 *  incremented only after a run throws — so the run in hand is number
 *  `attempts + 1` and the final run arrives as `maxAttempts - 1`. The worker
 *  once compared `job.attempts` itself against the budget, which made the
 *  give-up branch unreachable: the row kept saying "retrying" after the last
 *  attempt had already run and the job was marked failed. Route every reading
 *  of `job.attempts` through here so the two numbering schemes can never be
 *  conflated again. */
export function workerAttempt(
  priorAttempts: number,
  maxAttempts = RETRY_MAX_ATTEMPTS,
  cause: RetryCause = "busy",
): { attemptNo: number; lastChance: boolean; note: string } {
  const attemptNo = priorAttempts + 1;
  return {
    attemptNo,
    lastChance: retriesExhausted(attemptNo, maxAttempts),
    note: retryNote(attemptNo, maxAttempts, cause),
  };
}

/** What the worker does after attempt `attemptNo` came back still unresolved:
 *  the sentence the row gets, and the next attempt with its wait, or none
 *  once this was the last. One decision, so the words and the schedule
 *  cannot disagree. */
export function retryStep(
  attemptNo: number,
  cause: RetryCause,
  maxAttempts = RETRY_MAX_ATTEMPTS,
): { note: string; lastChance: boolean; next: { attempt: number; delayMs: number } | null } {
  const lastChance = retriesExhausted(attemptNo, maxAttempts);
  return {
    note: retryNote(attemptNo, maxAttempts, cause),
    lastChance,
    next: lastChance ? null : { attempt: attemptNo + 1, delayMs: nextRetryDelayMs(attemptNo) },
  };
}

/** A row as the inbox reads it, for retryHasRunOut. */
export interface RetryingRow {
  status?: string | null;
  suggested_name?: string | null;
  suggested_metadata?: Record<string, unknown> | null;
  updated_at?: string | Date | null;
}

/** Is this row still claiming a retry that cannot be coming? True when it
 *  carries the retry flag, is unnamed and pending, and its last write is
 *  older than the whole chain could take. */
export function retryHasRunOut(row: RetryingRow, now = Date.now()): boolean {
  if (row.status !== "pending" || row.suggested_name) return false;
  if (!(row.suggested_metadata as { rate_limited?: unknown } | null)?.rate_limited) return false;
  const at = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
  return Number.isFinite(at) && now - at > RETRY_WINDOW_MS;
}

/** Queue a fresh look-up for a row a throttled provider left unresolved. */
export async function enqueueRetryLookup(args: {
  orgId: string;
  itemId: string;
  upc: string;
  orgSlug: string;
  /** The attempt this job will be (1-based). The chain carries its own count
   *  so it can keep its own schedule; core-queue's count is only for a run
   *  that crashed. */
  attempt?: number;
  delayMs?: number;
}): Promise<void> {
  await platform().queue.enqueue({
    orgId: args.orgId,
    queue: RETRY_LOOKUP_QUEUE,
    payload: { itemId: args.itemId, upc: args.upc, orgSlug: args.orgSlug, attempt: args.attempt ?? 1 },
    runAt: new Date(Date.now() + (args.delayMs ?? RETRY_FIRST_DELAY_MS)),
    // A run that throws (a database error, not a busy catalog) is retried by
    // the queue once more, and then the read-time run-out takes over.
    maxAttempts: 2,
  });
}
