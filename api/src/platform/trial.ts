// try/trial tier — the locked-down "try.cobblr.xyz" mode, gated by
// COBBLR_TIER=trial. Open-core and OFF by default: a normal instance (prod,
// staging, self-host) never sets COBBLR_TIER, so none of this runs.
// See docs/design-decisions/try-instance.md.

import { env } from "../env.js";
import { meta } from "../db/meta.js";
import { registerEntitlementGuard, type EntitlementGuard } from "./hosted-seams.js";

/** True on the `try` instance only. */
export const TRIAL_MODE = env.COBBLR_TIER === "trial";

/** Days until a new trial workspace's expiry stamp. */
export const TRIAL_TTL_DAYS = env.TRY_TTL_DAYS;

// The withheld modules are INSTANCE POLICY, not kernel code — the kernel never
// hardcodes a module name (that violates module isolation; see lint:isolation).
// The `try` box sets COBBLR_TRIAL_DENY_MODULES to the AI + outbound/abuse
// surface, e.g.:
//   core-ai,core-authoring,core-devices,core-integrations,core-public-surfaces
// (AI/authoring, physical-device + edge ingest, outbound sync + user webhooks,
// and anonymous public pages). Belt-and-suspenders: the box also sets
// COBBLR_AI_ENABLED=false and COBBLR_HOSTED=true, so a missing entry still can't
// turn AI or SSRF on. Domain modules (inventory, …) are user-chosen and stay
// available; the foundational substrate (files, tags, notifications, search, …)
// stays on, so in-app notifications and the feedback widget work.
export function parseTrialDenyList(csv: string | undefined): ReadonlySet<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Modules withheld on this trial instance (from COBBLR_TRIAL_DENY_MODULES). */
export const TRIAL_DENIED_MODULES = parseTrialDenyList(env.COBBLR_TRIAL_DENY_MODULES);

/** Is this module withheld on the trial tier? Always false off-trial. */
export function isTrialDenied(moduleName: string): boolean {
  return TRIAL_MODE && TRIAL_DENIED_MODULES.has(moduleName);
}

// ── per-demo unlocks (Slice 4) ─────────────────────────────────────────────
// A demo workspace carries an allow-list (orgs.demo_unlocks) of feature keys + module
// names it may use despite the trial cap. Load it once per check; a real trial (empty
// list) costs one indexed lookup and unlocks nothing.
export async function orgDemoUnlocks(orgId: string): Promise<ReadonlySet<string>> {
  if (!TRIAL_MODE) return EMPTY;
  const row = await meta.selectFrom("orgs").select("demo_unlocks").where("id", "=", orgId).executeTakeFirst();
  return row && row.demo_unlocks.length ? new Set(row.demo_unlocks) : EMPTY;
}
const EMPTY: ReadonlySet<string> = new Set();

/** Like isTrialDenied, but a per-demo unlock for this module overrides the denial —
 *  so an operator-provisioned demo can enable e.g. core-ai while real trials can't. */
export async function isTrialDeniedForOrg(moduleName: string, orgId: string): Promise<boolean> {
  if (!isTrialDenied(moduleName)) return false;
  return !(await orgDemoUnlocks(orgId)).has(moduleName);
}

// The feature keys the trial tier caps. SINGLE SOURCE OF TRUTH: the guard consults it,
// trialFeatureDecision switches on it, and the demo API validates unlock entries against it
// (a typo'd unlock like "files" instead of "files.upload" is then rejected, not silently
// no-op'd). `plan.upgrade` is here so convert-to-keep can't be a free self-serve escape
// from the trial cap — it's denied unless the cloud billing overlay's guard allows it
// (post-payment) or a specific demo is unlocked for it.
export const TRIAL_CAPPED_FEATURES: ReadonlySet<string> = new Set([
  "workspaces.create",
  "members.add",
  "files.upload",
  "plan.upgrade",
]);
const TRIAL_CAP_REASONS: Record<string, string> = {
  "workspaces.create": "The free trial is limited to one workspace — upgrade to add more.",
  "members.add": "The free trial is single-user — upgrade to invite members.",
  "files.upload": "The free trial doesn't support file uploads — items you scan still get their image automatically.",
  "plan.upgrade": "Keeping this workspace requires checkout — a free trial can't self-upgrade to a paid plan.",
};

/** The pure decision: does the trial tier withhold this feature, given the workspace's
 *  unlock list? Extracted so the (async, DB-touching) guard stays a thin wrapper. */
export function trialFeatureDecision(feature: string, unlocks: ReadonlySet<string>): { allow: boolean; reason?: string } {
  if (unlocks.has(feature)) return { allow: true }; // this demo is unlocked for it
  if (TRIAL_CAPPED_FEATURES.has(feature)) return { allow: false, reason: TRIAL_CAP_REASONS[feature] };
  return { allow: true };
}

// Trial entitlement caps. This guard denies the plan-limited actions the trial
// withholds: extra workspaces, extra members, and USER file uploads (enforced in
// the core-files upload route via entitlements.check). The anti-hosting rule is
// "never store a byte the user chose" — scan/catalog images are exempt because
// they store server-side through platform().files.write, which never hits that
// route. The rest is structural: the module denylist above + strict egress
// (COBBLR_HOSTED=true).
export const trialEntitlementGuard: EntitlementGuard = async (ctx) => {
  // Only pay the unlock lookup for a feature the trial actually caps.
  const unlocks = TRIAL_CAPPED_FEATURES.has(ctx.feature) ? await orgDemoUnlocks(ctx.orgId) : EMPTY;
  return trialFeatureDecision(ctx.feature, unlocks);
};

/** Call once at boot. No-op unless COBBLR_TIER=trial. */
export function registerTrialMode(): void {
  if (!TRIAL_MODE) return;
  registerEntitlementGuard(trialEntitlementGuard);
  console.log(
    `[trial] COBBLR_TIER=trial — single-workspace cap, ${TRIAL_TTL_DAYS}d expiry stamp, ` +
      `withholding: ${[...TRIAL_DENIED_MODULES].join(", ")}`,
  );
}
