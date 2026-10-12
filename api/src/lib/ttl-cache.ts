// A short-lived cache whose misses are SHARED.
//
// A list that resolves its rows concurrently asks the same question once per
// row. A TTL cache that only checks "is there a fresh entry" answers that
// from memory while it is warm, and while it is cold (first read, or the
// moment the TTL lapsed) EVERY row misses before the first load lands and runs
// its own query: 200 rows, 200 statements, on the one request that arrived at
// the wrong millisecond. That is the shape of the flake in the bounded-meta
// test (#4917): serverManagedFields' 5-second entry lapsing mid-list. A warm
// run cannot see it, so only a retry did. Here a miss starts ONE load and every
// concurrent asker awaits that same promise.
//
//   const defs = ttlCache<Def[]>(5_000);
//   const load = (orgId, kind) => defs.get(`${orgId}:${kind}`, () => readDefs(orgId, kind));
//   clear: defs.clear()   // or defs.delete(key)
//
// A load that REJECTS is not kept: the next asker tries again. A loader that
// wants its failure remembered (a fallback value for a few seconds) catches it
// itself and returns the fallback. A clear() or delete() that lands while a
// load is in flight wins: that load's answer is handed to the askers already
// waiting but is not stored, so an invalidation is never undone by a read that
// started before it.
export interface TtlCache<V> {
  get(key: string, load: () => Promise<V>): Promise<V>;
  delete(key: string): void;
  clear(): void;
  /** Forget every entry whose key starts with `prefix` (a workspace's id). */
  forgetPrefix(prefix: string): void;
}

// Every cache made, so a test can make ONE workspace's entries cold (the test
// door forget-org-caches) without touching anybody else's. A cache that is
// warm in one run and cold in the next is what made the bounded-meta test pass
// only on a retry; measuring from cold, every time, makes it deterministic.
const all = new Set<TtlCache<never>>();

/** Forget a workspace's entries in every ttlCache (keys start with its id). */
export function forgetOrgInTtlCaches(orgId: string): void {
  for (const c of all) c.forgetPrefix(orgId);
}

export function ttlCache<V>(ttlMs: number, now: () => number = Date.now): TtlCache<V> {
  // single-flight: this IS the shared-miss cache; `loading` below shares every miss
  const done = new Map<string, { at: number; value: V }>();
  const loading = new Map<string, Promise<V>>();
  const stamp = new Map<string, number>();
  let epoch = 0;
  const gen = (key: string) => epoch + (stamp.get(key) ?? 0);
  const cache: TtlCache<V> = {
    get(key, load) {
      const hit = done.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      const inFlight = loading.get(key);
      if (inFlight) return inFlight;
      const startedAt = gen(key);
      const p = load().then(
        (value) => {
          if (loading.get(key) === p) loading.delete(key);
          // ttl 0 is single-flight only: share the asks in flight, keep nothing.
          if (ttlMs > 0 && gen(key) === startedAt) done.set(key, { at: now(), value });
          return value;
        },
        (err) => {
          if (loading.get(key) === p) loading.delete(key);
          throw err;
        },
      );
      loading.set(key, p);
      return p;
    },
    delete(key) {
      done.delete(key);
      loading.delete(key);
      stamp.set(key, (stamp.get(key) ?? 0) + 1);
    },
    clear() {
      done.clear();
      loading.clear();
      stamp.clear();
      epoch++;
    },
    forgetPrefix(prefix) {
      for (const k of [...done.keys(), ...loading.keys()]) if (k.startsWith(prefix)) cache.delete(k);
    },
  };
  all.add(cache as TtlCache<never>);
  return cache;
}
