// Slice 4 — demo / debug workspaces. An operator provisions a blueprint-seeded, time-boxed
// workspace into an existing user's account (their try view), with per-demo entitlement
// unlocks so the demo can use what real trials lock. Reaping is already handled: the demo
// is a trial workspace (trial_expires_at set), so the Slice-1 reaper sweeps it at expiry.
// A convert-to-keep clears the expiry + unlocks and moves the workspace to a paid plan.

import { meta } from "../db/meta.js";
import { provisionOrgForUser } from "../routes/auth.js";
import { applyBlueprint, type BlueprintManifestT } from "../routes/blueprint.js";
import { enableModuleForOrg } from "../modules/enable.js";

export const DEMO_DEFAULT_DAYS = 7;
export const DEMO_MAX_DAYS = 30;

/** Clamp a requested demo lifetime to [1, DEMO_MAX_DAYS]; default 7. Pure. null/undefined/
 *  non-numeric all fall back to the default (note: Number(null) is 0, so guard it first). */
export function clampDemoDays(days: unknown): number {
  if (days == null) return DEMO_DEFAULT_DAYS;
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n)) return DEMO_DEFAULT_DAYS;
  return Math.max(1, Math.min(DEMO_MAX_DAYS, n));
}

/** Normalize an unlock allow-list: strings, trimmed, de-duped, non-empty. Pure. */
export function normalizeUnlocks(unlock: unknown): string[] {
  if (!Array.isArray(unlock)) return [];
  return [...new Set(unlock.map((u) => String(u).trim()).filter(Boolean))];
}

/** Split unlocks into module names (to enable) vs feature keys (guard-only). A feature key
 *  is dotted ("files.upload"); a module name is not ("core-ai"). Pure. */
export function splitUnlocks(unlocks: string[]): { modules: string[]; features: string[] } {
  const modules: string[] = [];
  const features: string[] = [];
  for (const u of unlocks) (u.includes(".") ? features : modules).push(u);
  return { modules, features };
}

export interface ProvisionDemoInput {
  userId: string;
  orgName: string;
  blueprint?: BlueprintManifestT | null;
  expiresInDays?: number;
  unlock?: string[];
}
export interface ProvisionDemoResult {
  orgId: string;
  slug: string;
  expiresAt: Date;
  unlocks: string[];
}

/** Provision a time-boxed, blueprint-seeded demo workspace for an existing user, with
 *  per-demo unlocks. Reuses provisionOrgForUser (org + owner membership + tenant DB),
 *  then stamps the demo's OWN expiry + unlocks (overriding the default trial stamp),
 *  enables any unlocked modules the demo needs, and applies the blueprint. */
export async function provisionDemoForUser(input: ProvisionDemoInput): Promise<ProvisionDemoResult> {
  const days = clampDemoDays(input.expiresInDays);
  const unlocks = normalizeUnlocks(input.unlock);
  const { orgId, slug } = await provisionOrgForUser(input.userId, input.orgName);

  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await meta
    .updateTable("orgs")
    .set({ trial_expires_at: expiresAt, demo_unlocks: unlocks, updated_at: new Date() })
    .where("id", "=", orgId)
    .execute();

  // Enable any unlocked MODULE (e.g. core-ai) the demo asked for — now permitted for this
  // org because the unlock we just wrote makes isTrialDeniedForOrg return false for it.
  const { modules } = splitUnlocks(unlocks);
  for (const m of modules) {
    try {
      await enableModuleForOrg(orgId, m, { userId: input.userId });
    } catch (e) {
      console.warn(`[demo] enable unlocked module ${m} for ${slug} skipped: ${(e as Error).message}`);
    }
  }

  if (input.blueprint) {
    try {
      await applyBlueprint(orgId, { id: input.userId, auth_method: "system" }, input.blueprint);
    } catch (e) {
      console.error(`[demo] applyBlueprint for ${slug} failed: ${(e as Error).message}`);
    }
  }

  return { orgId, slug, expiresAt, unlocks };
}

/** Convert a trial/demo workspace into a kept one: clear the expiry + unlocks and move it
 *  to a paid plan, so the reaper never touches it and the tier caps no longer apply. */
export async function convertDemoToKeep(orgId: string): Promise<void> {
  await meta
    .updateTable("orgs")
    .set({ trial_expires_at: null, demo_unlocks: [], plan: "paid", updated_at: new Date() })
    .where("id", "=", orgId)
    .execute();
}
