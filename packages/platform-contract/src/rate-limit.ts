// A sliding-window rate limiter, per key, in memory.
//
// The auth routes have carried this shape locally since they first shipped
// (api/src/routes/auth.ts, makePairLimiter); the scan intake routes shipped
// with NO ceiling at all - a stranger could upload receipts in a loop, each
// fanning out to metered AI (2026-08-25 public-release audit). Two copies of
// the sliding window would drift, so the rule moves here and both can import
// it.
//
// In-memory on purpose: the ceiling is an abuse backstop, not an accounting
// system. A restart forgetting the counts costs one window of generosity; a
// shared store would cost a dependency every self-hoster pays for.

/** True when this hit is allowed; false when the key is over its limit. */
export type SlidingWindowLimiter = (key: string) => boolean;

export function makeSlidingWindowLimiter(windowMs: number, max: number): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const prior = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (prior.length >= max) {
      hits.set(key, prior);
      return false;
    }
    prior.push(now);
    hits.set(key, prior);
    // Bounded memory: sweep dead keys once the map grows past any honest use.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    return true;
  };
}
