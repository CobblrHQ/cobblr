// Run async work in the order it was asked for, per key, without making the
// caller wait.
//
// A turn's progress events are written fire-and-forget on purpose: a slow event
// sink must never slow the answer. But "don't wait" was implemented as "don't
// order", so two writes could be in flight at once and the LAST event of a turn
// ("done") could be inserted before an earlier one ("tool-result") had landed.
// A reader that stops at `done` then sees a turn that never used a tool, which
// is how a long answer sometimes showed no steps at all — and what made the
// replay test fail intermittently for months with "expected [thinking, tool,
// tool] to include 'tool-result'".
//
// Keyed rather than global: two different turns must not queue behind each
// other, and a per-key chain keeps that true without any locking.

const chains = new Map<string, Promise<unknown>>();

/** Queue `work` behind anything already queued for `key`. Returns its result.
 *  A failure never poisons the chain — the next item still runs. */
export function serializeByKey<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  // Store a settled-either-way link so one rejection cannot break the queue,
  // and so an unhandled rejection is never attached to the stored promise.
  chains.set(key, next.then(
    () => undefined,
    () => undefined,
  ));
  return next;
}

/** Forget a key once its work is finished (a turn that has ended). Keeps the
 *  map from growing for the life of the process. */
export function releaseKey(key: string): void {
  chains.delete(key);
}

/** Test seam: how many keys are currently tracked. */
export function trackedKeyCount(): number {
  return chains.size;
}
