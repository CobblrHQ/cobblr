// Hosted-overlay extension seams. Open core registers NONE of these — the
// defaults are allow-all / no-op, so a self-hosted instance runs free and
// unrestricted. A proprietary hosted overlay may register
// implementations at boot to add plan gating, usage metering, lifecycle
// (verification / GDPR delete), and abuse rate-limiting. Mirrors the existing
// `ai.registerEntitlementGuard` / `ai.registerProvider` pattern.

import { featureOff } from "./features.js";
import { noteRefusal } from "./guard-refusals.js";
import type { RequestHandler } from "express";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type {
  AuthEmailMessage,
  AuthEmailSender,
  HostedPanel,
  HostedPanelSummary,
} from "@cobblr/platform-contract";

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

// The contract's own types, not a copy: a second declaration here drifted
// from the one modules call through (it never learned `used`).
import type { EntitlementCtx, EntitlementGuard } from "@cobblr/platform-contract";
export type { EntitlementCtx, EntitlementGuard };

let entitlementGuard: EntitlementGuard | null = null;
export function registerEntitlementGuard(g: EntitlementGuard): void {
  entitlementGuard = g;
}
/** Resolve an entitlement. No guard registered → allow. A guard that throws
 *  fails OPEN (never break core on a buggy overlay; the overlay owns robustness). */
export async function checkEntitlement(
  ctx: EntitlementCtx,
): Promise<{ allow: boolean; reason?: string }> {
  // Off on this site: the operator turned it off (COBBLR_FEATURES_OFF), or it
  // is an experiment the operator has not turned on (COBBLR_FEATURES_ON);
  // never a hostname written into the product (#4737).
  if (featureOff(ctx.feature)) return { allow: false, reason: "That is turned off on this instance." };
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
) => Promise<{
  allow: boolean;
  retryAfterSec?: number;
  reason?: string;
  /** Which rule refused, and what its bucket is keyed on: logged and counted (guard-refusals.ts), never the address. */
  rule?: string;
  key?: "address" | "global";
}>;

let requestGuard: RequestGuard | null = null;
export function registerRequestGuard(g: RequestGuard): void {
  requestGuard = g;
}
export function hasRequestGuard(): boolean {
  return requestGuard !== null;
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
/** Read-only answers every page needs BEFORE anyone signs in, which carry
 *  nothing to brute-force. They are kept out of the guard's shared bucket: one
 *  busy network behind one address (an office, a school, a review rig) used to
 *  spend that bucket and then could not even see the sign-in form, because
 *  GET /auth/config came back 429 with Retry-After: 300 (#3622). Each has its
 *  own generous per-address limit where it is served, and credential routes
 *  stay behind the guard. Paths are relative to /api/v1. */
export const GUARD_EXEMPT_READS: ReadonlySet<string> = new Set(["/auth/config"]);

/** Express middleware that consults the registered request guard. Mounted on
 *  the public/auth routes; a no-op until the overlay registers a guard. */
export function requestGuardMiddleware(): RequestHandler {
  return (req, res, next) => {
    if ((req.method === "GET" || req.method === "HEAD") && GUARD_EXEMPT_READS.has(req.path)) return next();
    void checkRequest({
      ip: req.ip ?? "",
      path: req.path,
      method: req.method,
      userId: (req as { session?: { id?: string } }).session?.id,
    }).then((v) => {
      if (v.allow) return next();
      // Every refusal is a log line and a count (/healthz rate_limited): the rule, what its
      // bucket is keyed on, and the route's first segment, never the address or the rest of
      // the path (a public route carries its token there). A guard that answered 429 silently
      // made "no one was refused" a guess (2026-10-07).
      const rule = ("rule" in v && v.rule) || "overlay";
      const key = ("key" in v && v.key) || "unknown";
      noteRefusal({ rule, key });
      console.warn(`[request-guard] 429 rule=${rule} key=${key} route=${req.method} /${req.path.split("/")[1] ?? ""}`);
      if ("retryAfterSec" in v && v.retryAfterSec) res.setHeader("Retry-After", String(v.retryAfterSec));
      res.status(429).json({
        error: { code: "rate_limited", message: ("reason" in v && v.reason) || "Too many requests." },
      });
    });
  };
}

// ───────────────────────── Seam 7: public webhooks ───────────────────────────
// A global, UNAUTHENTICATED webhook endpoint mounted at /api/v1/hooks/:id, for
// ACCOUNT-LEVEL provider webhooks (Stripe billing, a GitHub app, …) that are NOT
// tenant-scoped. Distinct from integrations.registerInboundHandler — that one is
// the per-workspace inbound receiver keyed by a token in the URL; this one has no
// tenant in the URL at all. The handler verifies its OWN signature (against the
// captured rawBody) and resolves any tenant from the payload. Open core registers
// no handlers, but the dispatch route is always mounted (404 for unknown ids), so
// a self-hoster who registers one from their own module gets the same seam.

export interface PublicWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string;
  query: Record<string, unknown>;
}
export interface PublicWebhookHandler {
  id: string;
  handle: (
    req: PublicWebhookRequest,
  ) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}

const webhookHandlers = new Map<string, PublicWebhookHandler>();
export function registerWebhook(h: PublicWebhookHandler): void {
  if (webhookHandlers.has(h.id)) {
    console.log(`[hooks] replacing webhook handler '${h.id}'`);
  }
  webhookHandlers.set(h.id, h);
}
export function getWebhookHandler(id: string): PublicWebhookHandler | undefined {
  return webhookHandlers.get(id);
}

// ───────────────────────── Seam 8: hosted settings panels ────────────────────
// A module/overlay contributes a settings page as a DECLARATIVE view (see the
// contract's HostedPanel) — no frontend code ships into the open-core web bundle.
// Open core registers no panels, so a self-hoster's Configuration shows none of
// them (not even their names). The web app lists summaries to build tiles/routes,
// fetches a panel's view, and posts its actions, all through one generic renderer.

const hostedPanels = new Map<string, HostedPanel>();
export function registerHostedPanel(p: HostedPanel): void {
  hostedPanels.set(p.id, p);
}
export function listHostedPanels(): HostedPanelSummary[] {
  return [...hostedPanels.values()].map((p) => ({ id: p.id, label: p.label, icon: p.icon, group: p.group }));
}
export function getHostedPanel(id: string): HostedPanel | undefined {
  return hostedPanels.get(id);
}

/** A panel is configuration (billing, a workspace's chat integration) unless
 *  it says otherwise, and a panel is handed no way to check the caller's role
 *  before the kernel asks this. One the caller may not use answers exactly
 *  like a panel that does not exist. */
export function panelOpenTo(panel: Pick<HostedPanel, "minRole">, role: string | undefined): boolean {
  return roleSatisfies(role, [panel.minRole ?? "admin"]);
}
