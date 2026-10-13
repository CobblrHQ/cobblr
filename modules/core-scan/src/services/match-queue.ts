/** Explicit matches must read the row after older work has finished writing it.
 * Background duplicates have no new input and can be dropped. */
export function createMatchQueue() {
  const inFlight = new Map<string, Promise<unknown>>();
  return async function run<T>(key: string, force: boolean, work: () => Promise<T>): Promise<T | null> {
    const prior = inFlight.get(key);
    if (prior && !force) return null;
    const next = (async () => {
      await prior?.catch(() => undefined);
      return work();
    })();
    inFlight.set(key, next);
    try {
      return await next;
    } finally {
      if (inFlight.get(key) === next) inFlight.delete(key);
    }
  };
}
