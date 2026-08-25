// Allocate a turn-event `seq` that is collision-safe across api replicas.
//
// seq is `coalesce(max(seq),0)+1` per turn. Within one process the emit chain
// (serialize-by-key.ts) keeps two writers from computing the same number, but
// the step-relay endpoint (POST /turns/open/steps) can run on a DIFFERENT api
// replica than the loop, and those two do NOT share that chain. Under READ
// COMMITTED both read the same max before either commits, so both compute the
// same seq. That is not silent: the events table's PRIMARY KEY (turn_id, seq)
// rejects the second writer with a unique violation (SQLSTATE 23505). Without a
// retry that error was swallowed and the event was lost forever — a reader that
// stops at `done` then sees a finished turn missing a step, permanently.
//
// So a colliding insert re-reads max(seq)+1 and tries again. Each attempt reads
// a fresh max, so N genuinely-concurrent writers settle into N distinct seqs in
// at most N rounds. The PK is load-bearing: it is what turns a lost duplicate
// into a retryable conflict.

/** SQLSTATE for unique_violation. A collision on (turn_id, seq) surfaces as this
 *  from node-postgres (the code rides on the thrown error and, when kysely wraps
 *  it, on `.cause`). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (e: unknown): unknown =>
    typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (code(err) === "23505") return true;
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  return code(cause) === "23505";
}

/** Default attempts before a genuine failure is reported. Sized well above any
 *  plausible concurrent-writer count for one turn (the loop plus a handful of
 *  relayed steps), so exhaustion means a real fault, not contention. */
export const SEQ_MAX_ATTEMPTS = 8;

/** Run `attempt` (which inserts the event and returns its seq), retrying only on
 *  a seq collision. Any other error propagates untouched on the first throw.
 *  Exhausting the attempts re-throws the last collision so the caller's own
 *  failure handling (log + give up) still runs. */
export async function insertWithSeqRetry(
  attempt: () => Promise<number>,
  opts: { maxAttempts?: number; isConflict?: (e: unknown) => boolean } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? SEQ_MAX_ATTEMPTS;
  const isConflict = opts.isConflict ?? isUniqueViolation;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isConflict(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Run `op` durably: on failure, `onError("retry", err)` then try ONCE more; if
 *  that also fails, `onError("lost", err)` and return `fallback()` WITHOUT
 *  throwing. Used for a progress-event persist, where a failed write must be
 *  observable (logged) but must never crash the turn it only describes — the row
 *  is the source of truth and a later poll still finds the rest. */
export async function persistOrLog<T>(
  op: () => Promise<T>,
  onError: (phase: "retry" | "lost", err: unknown) => void,
  fallback: () => T,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    onError("retry", err);
    try {
      return await op();
    } catch (err2) {
      onError("lost", err2);
      return fallback();
    }
  }
}
