// Per-account login lockout — the PURE decision, no I/O.
//
// The IP limiter in routes/auth.ts caps floods from one address, but it is
// per-instance (canary + main each keep their own Map) and IP-only, so it does
// nothing against distributed credential stuffing that rotates IPs across many
// accounts. This adds a per-ACCOUNT failed-login counter with exponential
// backoff, persisted in cobblr_meta so the count is shared across every api
// instance. The routing/storage lives in routes/auth.ts; the arithmetic that
// decides "is this account locked, and for how long" lives here so it can be
// unit-tested with no database (audit M-BRUTE).

/** Consecutive failures allowed before the FIRST lock. Below this, a legitimate
 *  user fat-fingering their password is never locked out — five wrong tries is
 *  already a lot of typos; the sixth trips the gate. */
export const LOCKOUT_THRESHOLD = 6;

/** Lock duration at the first lock (on failure #LOCKOUT_THRESHOLD). Gentle on a
 *  real user who is close to remembering: two minutes, not thirty. */
export const LOCKOUT_BASE_MS = 2 * 60_000;

/** Backoff cap. Each further failure past the threshold doubles the wait, but it
 *  never exceeds this — long enough to make stuffing pointless, short enough that
 *  a locked-out human is never stranded for the rest of the day. */
export const LOCKOUT_MAX_MS = 30 * 60_000;

export interface LockoutDecision {
  /** True once `failedCount` has reached the threshold. */
  locked: boolean;
  /** Wall-clock instant the account unlocks, or null when not locked. */
  lockedUntil: Date | null;
  /** The backoff applied for this failure (ms), 0 when below the threshold. */
  backoffMs: number;
}

/**
 * Decide the lockout for an account that has just recorded `failedCount`
 * CONSECUTIVE failures (the increment for the current attempt already applied).
 *
 * Below the threshold: not locked. At and past it: an exponentially growing
 * window starting at LOCKOUT_BASE_MS and doubling per extra failure, capped at
 * LOCKOUT_MAX_MS. Pure — `now` is injected so the caller (and the test) control
 * the clock.
 */
export function lockoutState(failedCount: number, now: Date): LockoutDecision {
  if (failedCount < LOCKOUT_THRESHOLD) {
    return { locked: false, lockedUntil: null, backoffMs: 0 };
  }
  const stepsPastThreshold = failedCount - LOCKOUT_THRESHOLD; // 0 at the first lock
  const backoffMs = Math.min(LOCKOUT_BASE_MS * 2 ** stepsPastThreshold, LOCKOUT_MAX_MS);
  return { locked: true, lockedUntil: new Date(now.getTime() + backoffMs), backoffMs };
}

/**
 * Is an account whose stored `lockedUntil` is this value still locked at `now`?
 * A null/absent value, or one already in the past, is NOT locked. Pure.
 */
export function isLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}
