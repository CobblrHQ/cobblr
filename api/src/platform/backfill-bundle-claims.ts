// One-time, idempotent self-heal for the bundle-resource-claims ledger.
// DONE WHEN: the backfill touches 0 orgs on prod + staging + dev consistently
// (every install's claims ledger is populated); then delete this file and its
// boot call.
//
// BORN WITH: recordClaims (a bundle install writes its claims as it applies; this pass replays installs from before the ledger)
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
import { noteHealShim } from "./heal-shim-log.js";

export async function backfillBundleClaims(orgId?: string): Promise<number> {
  // One-shot historical self-heal (installs predating the claims ledger). Honours
  // the same skip flag as the other historical boot passes: CI's org pool is baked
  // by current code (claims already present), so this only scans ~250 tenants to
  // find nothing — it was ~14s of the pooled boot. Prod/staging never set the flag.
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  // Orgs with no ledger at all, in one query: an org that already has claims
  // (backfilled, or a new install recorded them) is never re-derived, which
  // would wrongly 'user'-claim modules. An org whose modules are all defaults
  // legitimately has none and is looked at again, cheaply, finding nothing.
  const orgRows = await meta
    .selectFrom("org_modules as m")
    .select("m.org_id")
    .distinct()
    .$if(orgId !== undefined, (q) => q.where("m.org_id", "=", orgId!))
    .where((eb) => eb.not(eb.exists(
      eb.selectFrom("bundle_resource_claims as c").select("c.id").whereRef("c.org_id", "=", "m.org_id"),
    )))
    .execute();
  let backfilled = 0;
  for (const { org_id } of orgRows) {
    let wrote = false;
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
        if (pi.instance_name) wrote = (await recordClaim(org_id, b.external_id, "instance", pi.instance_name)) || wrote;
        if (pi.module) {
          wrote = (await recordClaim(org_id, b.external_id, "module", pi.module)) || wrote;
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
        wrote = (await recordClaim(org_id, USER_SOURCE, "module", module_name)) || wrote;
      }
    }
    if (wrote) backfilled++;
  }
  // What it found is the orgs that gained a claim: one whose modules are all
  // defaults has nothing to claim and is not unfinished work. (A throw above
  // leaves nothing recorded, which is right: a pass that did not finish did
  // not find zero.)
  if (orgId === undefined) await noteHealShim("api/src/platform/backfill-bundle-claims.ts", backfilled);
  return backfilled;
}
