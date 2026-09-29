import type { Request, Response } from "express";

// Per-IP limits for the unauthenticated doors (sign-in, signup, pairing).
// Minimal in-memory sliding-window limiter — this api carries no
// express-rate-limit dependency. Per-instance + best-effort: brute-forcing a
// 128-bit, short-lived, single-use code is already infeasible; this just caps
// accidental floods + abusive bursts. Keyed by client IP.
export function makeIpLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    // Opportunistic cleanup so the map can't grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    return true;
  };
}

// The CI test harness logs in thousands of times from ONE ip (localhost) — the limits
// protect PROD, not the harness, so bypass them under the test rig. COBBLR_TEST_ORG_POOL is
// set only in ci.yml / the test rig (env.ts), never in prod.
export const IP_LIMITS_OFF = process.env.NODE_ENV === "test" || !!process.env.COBBLR_TEST_ORG_POOL;

/** True when this request should be rejected as over-limit. No-op under the test rig. */
export function overLimit(limiter: (k: string) => boolean, req: Request): boolean {
  return !IP_LIMITS_OFF && !limiter(req.ip ?? "unknown");
}

const RATE_LIMITED = { error: { code: "rate_limited", message: "Too many attempts — wait a moment." } };

/** Every limiter here is a one-minute window, so a refusal can say how long to
 *  wait; a client that knows counts down instead of retrying into the wall. */
export function rateLimited(res: Response): Response {
  res.setHeader("Retry-After", "60");
  return res.status(429).json(RATE_LIMITED);
}
