// A burst of scans shares its menu reads (#9251). Every scan's match rebuilt the
// workspace's menu over the api's own routes, with no sharing between scans, so
// eight scans at once held 38 of the api's meta clients for a menu they all read
// alike. A time-based cache would answer that too, and would route a scan away
// from a table made a moment before it, so nothing here outlives its read.
//
// A call never gets a read that started before it did. One made while a read
// runs joins the single read that starts when that one ends, so what changed
// before the call is in its answer. Each caller gets its own copy, because a
// menu is filtered and extended by whoever holds it.
export function sharedRead<A, T>(keyOf: (args: A) => string, read: (args: A) => Promise<T>): (args: A) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  const queued = new Map<string, Promise<T>>();
  const start = (key: string, args: A): Promise<T> => {
    const p = (async () => {
      try {
        return await read(args);
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, p);
    return p;
  };
  const joined = (key: string, args: A): Promise<T> => {
    const inFlight = running.get(key);
    if (!inFlight) return start(key, args);
    const waiting = queued.get(key);
    if (waiting) return waiting;
    const next = inFlight.catch(() => undefined).then(() => {
      queued.delete(key);
      return start(key, args);
    });
    queued.set(key, next);
    return next;
  };
  return async (args: A) => structuredClone(await joined(keyOf(args), args));
}
