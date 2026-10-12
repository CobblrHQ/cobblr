// One run at a time per key, and one more after it when anything asked meanwhile.
//
// WHY (#5969, the starvation guard, 2026-10-12): every activity row and every event fired two "this workspace
// changed" updates on share_links (share-mirror noteWorkspaceChanged, share-edits noteCopiesChanged), fire and
// forget. A parts import logs a row per part, so one import launched thousands of identical updates at once
// and 19,907 callers waited on the 80-client meta pool, on a quiet box, in a run whose every test passed.
//
// A coalesced function keeps what each caller needs: a call returns once a run that STARTED AFTER it has
// finished, so whatever it changed before calling is seen by that run. A call while one is in flight joins
// the single trailing run, never a run of its own; a call while nothing runs starts one.
export function perKeyCoalesced<K>(fn: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const running = new Map<K, Promise<void>>();
  const queued = new Map<K, Promise<void>>();
  const start = (key: K): Promise<void> => {
    const p = (async () => {
      try {
        await fn(key);
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, p);
    return p;
  };
  return (key: K) => {
    const inFlight = running.get(key);
    if (!inFlight) return start(key);
    const waiting = queued.get(key);
    if (waiting) return waiting;
    // Runs once the current one ends, whether it succeeded or not; its own error goes to its own callers.
    const next = inFlight.catch(() => undefined).then(() => {
      queued.delete(key);
      return start(key);
    });
    queued.set(key, next);
    return next;
  };
}
