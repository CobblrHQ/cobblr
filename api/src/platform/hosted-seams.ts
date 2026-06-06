// Hosted-overlay extension seams. Open core registers NONE of these — the
// defaults are allow-all / no-op, so a self-hosted instance runs free and
// unrestricted. The proprietary cloud overlay (cobblr-cloud) registers
// implementations at boot to add plan gating, usage metering, lifecycle
// (verification / GDPR delete), and abuse rate-limiting. Mirrors the existing
// `ai.registerEntitlementGuard` / `ai.registerProvider` pattern.

import type { RequestHandler } from "express";
import type { AuthEmailMessage, AuthEmailSender } from "@cobblr/platform-contract";

// ───────────────────────── Seam 3: auth-email sender ─────────────────────────
// Platform-level (pre-workspace) email for verify / reset / magic-link. Open
// core registers none → the auth routes fall back to the inline dev link /
// admin-managed reset. A self-hoster wires their own SMTP/API sender; the
// overlay injects a managed one.
let authEmailSender: AuthEmailSender | null = null;
export function registerAuthEmailSender(s: AuthEmailSender): void {
  authEmailSender = s;
}
export function hasAuthEmailSender(): boolean {
  return authEmailSender !== null;
}
export async function sendAuthEmail(msg: AuthEmailMessage): Promise<boolean> {
  if (!authEmailSender) return false;
  try {
    await authEmailSender(msg);
    return true;
  } catch (err) {
    console.warn(`[auth-email] ${msg.kind} send failed:`, (err as Error).message);
    return false;
  }
}

// ───────────────────────── Seam 1: general entitlement guard ─────────────────
// Gate any plan-limited action (not just AI): create a workspace, add a member,
// enable a module, install a sandboxed module, store a file, … The overlay maps
// `feature` → the org's plan allowance. Open core: no guard → everything allowed.

export interface EntitlementCtx {
  orgId: string;
  /** Dotted feature key, e.g. "workspaces.create", "members.add",
   *  "modules.enable", "files.store", "sandbox.install". */
  feature: string;
  /** Units being requested (default 1) — e.g. bytes for files.store. */
  quantity?: number;
  /** The user attempting the action, if known. */
  userId?: string;
}
export type EntitlementGuard = (
  ctx: EntitlementCtx,
) => Promise<{ allow: boolean; reason?: string }>;

let entitlementGuard: EntitlementGuard | null = null;
export function registerEntitlementGuard(g: EntitlementGuard): void {
  entitlementGuard = g;
}
/** Resolve an entitlement. No guard registered → allow. A guard that throws
 *  fails OPEN (never break core on a buggy overlay; the overlay owns robustness). */
export async function checkEntitlement(
  ctx: EntitlementCtx,
): Promise<{ allow: boolean; reason?: string }> {
  if (!entitlementGuard) return { allow: true };
  try {
    return await entitlementGuard(ctx);
  } catch (err) {
    console.warn(`[entitlements] guard threw for ${ctx.feature}; allowing:`, (err as Error).message);
    return { allow: true };
  }
}

// ───────────────────────── Seam 5: usage metering ────────────────────────────
// Emit a billable/observable event. The overlay aggregates these into Stripe
// usage records / plan-limit counters. Open core: no sink → events are dropped.

export interface MeterEvent {
  orgId?: string;
  /** e.g. "ai.tokens", "files.bytes_stored", "members.added", "wire.fired". */
  kind: string;
  quantity: number;
  meta?: Record<string, unknown>;
}
export type MeterSink = (e: MeterEvent) => void;

const meterSinks: MeterSink[] = [];
export function registerMeterSink(s: MeterSink): void {
  meterSinks.push(s);
}
/** Record a metering event. Synchronous + swallows sink errors — metering must
 *  never slow or break a request. */
export function meter(e: MeterEvent): void {
  for (const sink of meterSinks) {
    try {
      sink(e);
    } catch (err) {
      console.warn(`[metering] sink threw for ${e.kind}:`, (err as Error).message);
    }
  }
}

// ───────────────────────── Seam 6: account lifecycle ─────────────────────────
// Hooks the overlay attaches to provision (e.g. send a verification email) and
// account deletion (GDPR export + purge). Open core fires them with no hooks.

export interface SignupCtx {
  userId: string;
  email: string;
  /** The workspace auto-created at signup. */
  orgId: string;
}
export interface AccountDeleteCtx {
  userId: string;
  email: string;
}
export interface LifecycleHooks {
  onSignup?: (ctx: SignupCtx) => Promise<void> | void;
  onAccountDelete?: (ctx: AccountDeleteCtx) => Promise<void> | void;
}

const lifecycleHooks: LifecycleHooks[] = [];
export function registerLifecycleHooks(h: LifecycleHooks): void {
  lifecycleHooks.push(h);
}
export async function fireSignup(ctx: SignupCtx): Promise<void> {
  for (const h of lifecycleHooks) {
    try {
      await h.onSignup?.(ctx);
    } catch (err) {
      console.warn("[lifecycle] onSignup hook failed:", (err as Error).message);
    }
  }
}
export async function fireAccountDelete(ctx: AccountDeleteCtx): Promise<void> {
  for (const h of lifecycleHooks) {
    try {
      await h.onAccountDelete?.(ctx);
    } catch (err) {
      console.warn("[lifecycle] onAccountDelete hook failed:", (err as Error).message);
    }
  }
}

// ───────────────────────── Seam 4: request guard (rate-limit / abuse) ─────────
// A guard the overlay registers to throttle / block requests (per-IP rate
// limits, captcha-gated signup, fraud blocks). Open core: no guard → all allowed.

export interface RequestGuardCtx {
  ip: string;
  path: string;
  method: string;
  userId?: string;
}
export type RequestGuard = (
  ctx: RequestGuardCtx,
) => Promise<{ allow: boolean; retryAfterSec?: number; reason?: string }>;

let requestGuard: RequestGuard | null = null;
export function registerRequestGuard(g: RequestGuard): void {
  requestGuard = g;
}
async function checkRequest(ctx: RequestGuardCtx) {
  if (!requestGuard) return { allow: true as const };
  try {
    return await requestGuard(ctx);
  } catch (err) {
    console.warn("[request-guard] threw; allowing:", (err as Error).message);
    return { allow: true as const };
  }
}
/** Express middleware that consults the registered request guard. Mounted on
 *  the public/auth routes; a no-op until the overlay registers a guard. */
export function requestGuardMiddleware(): RequestHandler {
  return (req, res, next) => {
    void checkRequest({
      ip: req.ip ?? "",
      path: req.path,
      method: req.method,
      userId: (req as { session?: { id?: string } }).session?.id,
    }).then((v) => {
      if (v.allow) return next();
      if ("retryAfterSec" in v && v.retryAfterSec) res.setHeader("Retry-After", String(v.retryAfterSec));
      res.status(429).json({
        error: { code: "rate_limited", message: ("reason" in v && v.reason) || "Too many requests." },
      });
    });
  };
}
