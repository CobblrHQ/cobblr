// In-core default request guard — a dependency-free, in-memory sliding-window
// rate limiter for the abuse-sensitive surfaces (auth, anonymous token routes,
// feedback). The hosted overlay may register its own, more sophisticated guard
// (distributed, captcha-gated); if it does, that one wins and this never
// registers. This exists so a public deploy WITHOUT the overlay (self-hosted
// path B in PRODUCTION_DEPLOY.md) isn't wide open to brute force.
//
// Scope: only the sensitive route classes are limited. Normal authenticated
// app traffic is untouched, so a busy member session is never throttled.
//
// Caveat: in-memory ⇒ per-process. With multiple api replicas the effective
// limit is N× the configured value. Fine for the single-replica deploys we
// run today; the overlay's guard is the multi-replica answer.

import {
  registerRequestGuard,
  hasRequestGuard,
  type RequestGuardCtx,
} from "./hosted-seams.js";

interface Rule {
  max: number;
  windowMs: number;
}

// Route classes and their limits, matched by path prefix (most specific first).
const AUTH: Rule = { max: 20, windowMs: 5 * 60_000 };       // login/signup/magic/reset/verify
const ANON: Rule = { max: 60, windowMs: 60_000 };           // public token surfaces
const FEEDBACK: Rule = { max: 10, windowMs: 60_000 };       // feedback submissions

export function classify(path: string): { cls: string; rule: Rule } | null {
  if (path.startsWith("/auth/")) return { cls: "auth", rule: AUTH };
  if (path.startsWith("/feedback")) return { cls: "feedback", rule: FEEDBACK };
  if (
    path.startsWith("/public/") ||
    path.startsWith("/calendar/") ||
    path.startsWith("/qr/") ||
    path.startsWith("/integrations/")
  ) {
    return { cls: "anon", rule: ANON };
  }
  return null; // everything else is unlimited here
}

// key → sorted list of request timestamps within the window.
const hits = new Map<string, number[]>();
let lastSweep = 0;

function allow(key: string, rule: Rule, now: number): boolean {
  const cutoff = now - rule.windowMs;
  const arr = (hits.get(key) ?? []).filter((t) => t > cutoff);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= rule.max;
}

function sweep(now: number): void {
  // Opportunistic GC so the Map doesn't grow unbounded across IPs.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const widest = Math.max(AUTH.windowMs, ANON.windowMs, FEEDBACK.windowMs);
  for (const [k, arr] of hits) {
    if (arr.length === 0 || arr[arr.length - 1]! < now - widest) hits.delete(k);
  }
}

/** Register the in-core limiter unless one is already registered (the overlay's
 *  takes precedence) or it's explicitly disabled. Returns whether it registered. */
export function registerDefaultRequestGuard(now: () => number = Date.now): boolean {
  if (hasRequestGuard()) return false;
  if (process.env.COBBLR_RATELIMIT === "off") return false;
  // On by default in production (the public surface); off in dev/test so the
  // app and e2e suite aren't throttled. Force-on anywhere with COBBLR_RATELIMIT=on.
  if (process.env.COBBLR_RATELIMIT !== "on" && process.env.NODE_ENV !== "production") {
    return false;
  }

  registerRequestGuard(async (ctx: RequestGuardCtx) => {
    const hit = classify(ctx.path);
    if (!hit) return { allow: true };
    const t = now();
    sweep(t);
    const key = `${hit.cls}:${ctx.ip}`;
    if (allow(key, hit.rule, t)) return { allow: true };
    return {
      allow: false,
      retryAfterSec: Math.ceil(hit.rule.windowMs / 1000),
      reason: "Too many requests — slow down and try again shortly.",
    };
  });
  return true;
}
