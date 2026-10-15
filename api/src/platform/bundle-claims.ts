// Bundle resource claims — the provenance/refcount behind a clean bundle uninstall.
//
// A bundle install enables modules, creates module instances and sets up
// places. Every one of those it CAUSED is claimed: the modules its tables live
// on, the modules it switched on because it needed them, and the places it
// created (never a place that was already there, never a module already on). Two bundles (and
// the user) can all need the same module. So uninstall must disable a module /
// delete an instance ONLY when no source still claims it — you can't tell that
// from current state alone. Each install records a claim per resource it owns
// (source = the bundle's external_id); a manual enable records source='user'
// (which pins the module forever). Uninstall drops that source's claims, then
// tears down whatever drops to zero claims.
//
// See docs/design-decisions/bundle-uninstall-refcount.md.

import { meta } from "../db/meta.js";
import { canonicalModuleName, getEntry } from "../modules/registry.js";
import { isDefaultModule } from "../modules/enable.js";

/** `place` is a location an install created (resource_key = its id). */
export type ClaimType = "module" | "instance" | "place";
export interface ResourceClaim {
  resource_type: ClaimType;
  resource_key: string;
}

/** The literal source for a user's manual module enable (vs a bundle external_id). */
export const USER_SOURCE = "user";

/** Record a claim. Idempotent — re-recording on a bundle UPGRADE is a no-op, so
 *  the unique (org, source, type, key) is never violated. True only when a row
 *  was written.
 *
 *  Never a claim on a module every workspace is born with: reconcileDefaultModules
 *  deletes those at every boot, so a writer that recorded one made the boot
 *  backfills put it back, and every boot rebuilt the ledger of hundreds of
 *  workspaces (core #6707). */
export async function recordClaim(
  orgId: string,
  source: string,
  resourceType: ClaimType,
  resourceKey: string,
): Promise<boolean> {
  if (resourceType === "module") {
    resourceKey = canonicalModuleName(resourceKey);
    const entry = getEntry(resourceKey);
    if (entry && isDefaultModule(entry)) return false;
  }
  const row = await meta
    .insertInto("bundle_resource_claims")
    .values({ org_id: orgId, source, resource_type: resourceType, resource_key: resourceKey })
    .onConflict((oc) =>
      oc.columns(["org_id", "source", "resource_type", "resource_key"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function recordClaims(
  orgId: string,
  source: string,
  claims: ResourceClaim[],
): Promise<void> {
  for (const c of claims) await recordClaim(orgId, source, c.resource_type, c.resource_key);
}

/** The resources a single source (a bundle external_id, or 'user') still claims. */
export async function claimsForSource(orgId: string, source: string): Promise<ResourceClaim[]> {
  const rows = await meta
    .selectFrom("bundle_resource_claims")
    .select(["resource_type", "resource_key"])
    .where("org_id", "=", orgId)
    .where("source", "=", source)
    .execute();
  return rows.map((r) => ({ resource_type: r.resource_type as ClaimType, resource_key: r.resource_key }));
}

/** Which bundles made each instance (instance name → bundle external ids):
 *  the shared name for a table that is the same in every workspace, which the
 *  scan learning loop routes by (#3769). The user's own claim is left out. */
export async function bundlesByInstance(orgId: string): Promise<Map<string, string[]>> {
  const rows = await meta
    .selectFrom("bundle_resource_claims")
    .select(["source", "resource_key"])
    .where("org_id", "=", orgId)
    .where("resource_type", "=", "instance")
    .where("source", "<>", USER_SOURCE)
    .execute();
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.resource_key, [...(out.get(r.resource_key) ?? []), r.source]);
  return out;
}

/** Drop every claim a source holds — called when a bundle is uninstalled. */
export async function removeClaimsForSource(orgId: string, source: string): Promise<void> {
  await meta
    .deleteFrom("bundle_resource_claims")
    .where("org_id", "=", orgId)
    .where("source", "=", source)
    .execute();
}

/** How many sources still claim a resource — the refcount. 0 ⇒ safe to tear down. */
export async function countClaimsFor(orgId: string, type: ClaimType, key: string): Promise<number> {
  if (type === "module") key = canonicalModuleName(key);
  const r = await meta
    .selectFrom("bundle_resource_claims")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("resource_type", "=", type)
    .where("resource_key", "=", key)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}
