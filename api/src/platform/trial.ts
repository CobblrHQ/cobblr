// try/trial tier — the locked-down "try.cobblr.xyz" mode, gated by
// COBBLR_TIER=trial. Open-core and OFF by default: a normal instance (prod,
// staging, self-host) never sets COBBLR_TIER, so none of this runs.
// See docs/design-decisions/try-instance.md.

import { env } from "../env.js";
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

// Trial entitlement caps. This guard denies the plan-limited actions the trial
// withholds: extra workspaces, extra members, and USER file uploads (enforced in
// the core-files upload route via entitlements.check). The anti-hosting rule is
// "never store a byte the user chose" — scan/catalog images are exempt because
// they store server-side through platform().files.write, which never hits that
// route. The rest is structural: the module denylist above + strict egress
// (COBBLR_HOSTED=true).
export const trialEntitlementGuard: EntitlementGuard = async (ctx) => {
  switch (ctx.feature) {
    case "workspaces.create":
      return { allow: false, reason: "The free trial is limited to one workspace — upgrade to add more." };
    case "members.add":
      return { allow: false, reason: "The free trial is single-user — upgrade to invite members." };
    case "files.upload":
      return {
        allow: false,
        reason: "The free trial doesn't support file uploads — items you scan still get their image automatically.",
      };
    default:
      return { allow: true };
  }
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
