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
//
// COBBLR_IP_LIMITS_OFF=true is the same switch for a harness stack that is NOT the test rig
// (2026-10-14): the nightly walk boots a development stack and walks three specs at once, each
// signing up its own workspace from localhost, and the 15-a-minute signup limit refused 124 of
// 370 specs before they began. It never switches the test org pool on. A production node that
// sets it refuses to boot, and a value other than true or false refuses too.
export function ipLimitsOff(e: NodeJS.ProcessEnv): boolean {
  const flag = e.COBBLR_IP_LIMITS_OFF;
  if (flag !== undefined && flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error(`COBBLR_IP_LIMITS_OFF must be true or false, not ${JSON.stringify(flag)}`);
  }
  if (flag === "true" && e.NODE_ENV === "production") {
    throw new Error("COBBLR_IP_LIMITS_OFF must never be set on a production node: it removes the per-address sign-in and signup limits");
  }
  return e.NODE_ENV === "test" || !!e.COBBLR_TEST_ORG_POOL || flag === "true";
}
export const IP_LIMITS_OFF = ipLimitsOff(process.env);

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
