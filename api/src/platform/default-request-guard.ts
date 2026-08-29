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

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

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

// The generic self-serve signup — the account-creation vector. Distinct from
// /auth/signup-invite/:token (single-use, invite-gated → not floodable), so
// match it exactly, not by prefix.
export function isSignupPath(path: string): boolean {
  return path === "/auth/signup";
}

/** Handing out a no-account sandbox is account creation without an account, so
 *  it needs its own limit — the signup caps are per DAY, and a sandbox that
 *  lives an hour wants an hourly one. Generic: the guard names no tier. */
export function isSandboxPath(path: string): boolean {
  // /try/start, NOT /try. /try only draws the "are you human" page, which
  // provisions nothing - and counting it meant a person who opened the link and
  // refreshed once was locked out for an hour without ever getting a sandbox.
  // Looking must be free; asking is what costs.
  return path === "/try/start";
}

// Optional daily caps on account creation, ON TOP of the AUTH brute-force limit.
// Both unset (default) → no extra signup limiting, so a self-host / dev box is
// unchanged. A public host that opens self-serve signup (e.g. try.cobblr.xyz)
// sets these on the box — generic infra, not tier-specific code:
//   COBBLR_SIGNUP_MAX_PER_IP_PER_DAY  — per-IP accounts/day (e.g. 3)
//   COBBLR_SIGNUP_MAX_PER_DAY         — global accounts/day across the instance
export interface GuardConfig {
  signupPerIpPerDay: number | null;
  signupGlobalPerDay: number | null;
  sandboxPerIpPerHour: number | null;
  sandboxGlobalPerHour: number | null;
}

function intEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function readGuardConfig(): GuardConfig {
  return {
    signupPerIpPerDay: intEnv("COBBLR_SIGNUP_MAX_PER_IP_PER_DAY"),
    signupGlobalPerDay: intEnv("COBBLR_SIGNUP_MAX_PER_DAY"),
    sandboxPerIpPerHour: intEnv("TRY_SANDBOX_MAX_PER_IP_PER_HOUR"),
    sandboxGlobalPerHour: intEnv("TRY_SANDBOX_MAX_PER_HOUR"),
  };
}

// key → sorted list of request timestamps within the window.
const hits = new Map<string, number[]>();
let lastSweep = 0;

function allow(state: Map<string, number[]>, key: string, rule: Rule, now: number): boolean {
  const cutoff = now - rule.windowMs;
  const arr = (state.get(key) ?? []).filter((t) => t > cutoff);
  arr.push(now);
  state.set(key, arr);
  return arr.length <= rule.max;
}

function sweep(state: Map<string, number[]>, now: number, widest: number): void {
  // Opportunistic GC so the Map doesn't grow unbounded across IPs.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, arr] of state) {
    if (arr.length === 0 || arr[arr.length - 1]! < now - widest) state.delete(k);
  }
}

type Decision =
  | { allow: true }
  | { allow: false; retryAfterSec: number; reason: string };

function deny(rule: Rule, reason: string): Decision {
  return { allow: false, retryAfterSec: Math.ceil(rule.windowMs / 1000), reason };
}

// Pure decision core — takes the counter state + clock so it's testable without
// touching the module-global map or the registration seam.
export function decide(
  ctx: Pick<RequestGuardCtx, "ip" | "path">,
  cfg: GuardConfig,
  now: number,
  state: Map<string, number[]> = hits,
): Decision {
  const hasSignupCap = cfg.signupPerIpPerDay !== null || cfg.signupGlobalPerDay !== null;
  const hasSandboxCap = cfg.sandboxPerIpPerHour !== null || cfg.sandboxGlobalPerHour !== null;
  const widest = Math.max(
    AUTH.windowMs,
    ANON.windowMs,
    FEEDBACK.windowMs,
    hasSignupCap ? DAY_MS : 0,
    hasSandboxCap ? HOUR_MS : 0,
  );
  sweep(state, now, widest);

  // 1. Path-class brute-force limit (auth / feedback / anon).
  const hit = classify(ctx.path);
  if (hit && !allow(state, `${hit.cls}:${ctx.ip}`, hit.rule, now)) {
    return deny(hit.rule, "Too many requests — slow down and try again shortly.");
  }

  // 2. Daily signup caps, when configured — these STACK on the auth limit so a
  //    public host throttles account creation far tighter than 20/5min.
  if (hasSignupCap && isSignupPath(ctx.path)) {
    const signupReason = "You've reached today's signup limit. Please try again tomorrow.";
    if (
      cfg.signupPerIpPerDay !== null &&
      !allow(state, `signup-ip:${ctx.ip}`, { max: cfg.signupPerIpPerDay, windowMs: DAY_MS }, now)
    ) {
      return deny({ max: cfg.signupPerIpPerDay, windowMs: DAY_MS }, signupReason);
    }
    if (
      cfg.signupGlobalPerDay !== null &&
      !allow(state, "signup-global", { max: cfg.signupGlobalPerDay, windowMs: DAY_MS }, now)
    ) {
      return deny({ max: cfg.signupGlobalPerDay, windowMs: DAY_MS }, signupReason);
    }
  }

  // 3. Hourly sandbox caps. A no-account sandbox is account creation without an
  //    account: cheap to ask for, and each one is a real database. These stack
  //    on the auth limit above the same way the signup caps do. The population
  //    ceiling (how many exist AT ONCE) is a separate control in the route —
  //    this only bounds arrivals.
  if (hasSandboxCap && isSandboxPath(ctx.path)) {
    const reason = "You've started a few sandboxes already. Try again in an hour, or make an account.";
    if (
      cfg.sandboxPerIpPerHour !== null &&
      !allow(state, `sandbox-ip:${ctx.ip}`, { max: cfg.sandboxPerIpPerHour, windowMs: HOUR_MS }, now)
    ) {
      return deny({ max: cfg.sandboxPerIpPerHour, windowMs: HOUR_MS }, reason);
    }
    if (
      cfg.sandboxGlobalPerHour !== null &&
      !allow(state, "sandbox-global", { max: cfg.sandboxGlobalPerHour, windowMs: HOUR_MS }, now)
    ) {
      return deny({ max: cfg.sandboxGlobalPerHour, windowMs: HOUR_MS }, reason);
    }
  }

  return { allow: true };
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

  const cfg = readGuardConfig();
  registerRequestGuard(async (ctx: RequestGuardCtx) => decide(ctx, cfg, now()));
  return true;
}
