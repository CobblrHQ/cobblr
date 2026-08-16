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

export const RETRY_LOOKUP_QUEUE = "core-scan:retry-lookup";

/** Attempts before the row is told, honestly, that this is not resolving. */
export const RETRY_MAX_ATTEMPTS = 5;

/** How long to wait before the FIRST retry. Past the upcitemdb burst window,
 *  which is the throttle most scans actually hit; core-queue's own backoff
 *  spaces the attempts after this one. */
export const RETRY_FIRST_DELAY_MS = 60_000;

/** What the row should SAY, given where the retry has got to.
 *
 *  The old sentence was written once and never revised, so it kept promising a
 *  retry long after the client had given up. Every state below is reachable and
 *  each one is the truth at that moment. */
export function retryNote(attempts: number, maxAttempts = RETRY_MAX_ATTEMPTS): string {
  if (attempts <= 0) return "Barcode service is busy. Trying again in a minute.";
  if (attempts < maxAttempts) {
    return `Barcode service is busy. Trying again (attempt ${attempts + 1} of ${maxAttempts}).`;
  }
  return "Barcode service stayed busy, so this one is not resolving on its own. Fill in the name, or add a photo and let it identify from that.";
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
): { attemptNo: number; lastChance: boolean; note: string } {
  const attemptNo = priorAttempts + 1;
  return {
    attemptNo,
    lastChance: retriesExhausted(attemptNo, maxAttempts),
    note: retryNote(attemptNo, maxAttempts),
  };
}

/** Queue a fresh look-up for a row a throttled provider left unresolved. */
export async function enqueueRetryLookup(args: {
  orgId: string;
  itemId: string;
  upc: string;
  orgSlug: string;
}): Promise<void> {
  await platform().queue.enqueue({
    orgId: args.orgId,
    queue: RETRY_LOOKUP_QUEUE,
    payload: { itemId: args.itemId, upc: args.upc, orgSlug: args.orgSlug },
    runAt: new Date(Date.now() + RETRY_FIRST_DELAY_MS),
    maxAttempts: RETRY_MAX_ATTEMPTS,
  });
}
