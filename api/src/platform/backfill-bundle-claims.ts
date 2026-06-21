// One-time, idempotent self-heal for the bundle-resource-claims ledger.
//
// Existing workspaces predate the ledger, so a bundle uninstall couldn't refcount
// (it would either orphan resources or risk disabling a shared/user module).
// This replays each installed bundle's manifest into claims, and 'user'-claims any
// enabled module no bundle attributes — the safe default (a 'user' claim is never
// auto-disabled). After it runs, uninstall behaves correctly even for pre-ledger
// installs. Honors "updates must self-heal — never make a user reinstall".
//
// Runs once per org: skipped once an org has ANY claim row (backfilled, or actively
// claimed by a new install). Idempotent regardless (recordClaim is ON CONFLICT DO
// NOTHING). See docs/design-decisions/bundle-uninstall-refcount.md.

import { meta } from "../db/meta.js";
import { recordClaim, USER_SOURCE } from "./bundle-claims.js";

export async function backfillBundleClaims(): Promise<number> {
  // Every active org has org_modules rows; that's the set to consider.
  const orgRows = await meta.selectFrom("org_modules").select("org_id").distinct().execute();
  let backfilled = 0;
  for (const { org_id } of orgRows) {
    // Skip orgs that already have claims (already backfilled, or a new install
    // recorded claims directly — re-deriving would wrongly 'user'-claim modules).
    const has = await meta
      .selectFrom("bundle_resource_claims")
      .select("id")
      .where("org_id", "=", org_id)
      .limit(1)
      .executeTakeFirst();
    if (has) continue;

    // 1. Claims from each installed bundle's manifest (its provides_instances give
    //    both the instance it owns and the module that instance lives on).
    const bundles = await meta
      .selectFrom("bundles")
      .select(["external_id", "manifest"])
      .where("org_id", "=", org_id)
      .execute();
    const bundleModules = new Set<string>();
    for (const b of bundles) {
      const m = (typeof b.manifest === "string" ? JSON.parse(b.manifest) : b.manifest) as {
        provides_instances?: Array<{ instance_name?: string; module?: string }>;
      } | null;
      for (const pi of m?.provides_instances ?? []) {
        if (pi.instance_name) await recordClaim(org_id, b.external_id, "instance", pi.instance_name);
        if (pi.module) {
          await recordClaim(org_id, b.external_id, "module", pi.module);
          bundleModules.add(pi.module);
        }
      }
    }

    // 2. Every enabled module NOT attributable to a bundle → a 'user' claim, so a
    //    future bundle uninstall never auto-disables it.
    const enabled = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", org_id)
      .execute();
    for (const { module_name } of enabled) {
      if (!bundleModules.has(module_name)) {
        await recordClaim(org_id, USER_SOURCE, "module", module_name);
      }
    }
    backfilled++;
  }
  return backfilled;
}
