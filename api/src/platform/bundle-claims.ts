// Bundle resource claims — the provenance/refcount behind a clean bundle uninstall.
//
// A bundle install enables modules + creates module instances. Two bundles (and
// the user) can all need the same module. So uninstall must disable a module /
// delete an instance ONLY when no source still claims it — you can't tell that
// from current state alone. Each install records a claim per resource it owns
// (source = the bundle's external_id); a manual enable records source='user'
// (which pins the module forever). Uninstall drops that source's claims, then
// tears down whatever drops to zero claims.
//
// See docs/design-decisions/bundle-uninstall-refcount.md.

import { meta } from "../db/meta.js";

export type ClaimType = "module" | "instance";
export interface ResourceClaim {
  resource_type: ClaimType;
  resource_key: string;
}

/** The literal source for a user's manual module enable (vs a bundle external_id). */
export const USER_SOURCE = "user";

/** Record a claim. Idempotent — re-recording on a bundle UPGRADE is a no-op, so
 *  the unique (org, source, type, key) is never violated. */
export async function recordClaim(
  orgId: string,
  source: string,
  resourceType: ClaimType,
  resourceKey: string,
): Promise<void> {
  await meta
    .insertInto("bundle_resource_claims")
    .values({ org_id: orgId, source, resource_type: resourceType, resource_key: resourceKey })
    .onConflict((oc) =>
      oc.columns(["org_id", "source", "resource_type", "resource_key"]).doNothing(),
    )
    .execute();
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
  const r = await meta
    .selectFrom("bundle_resource_claims")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("resource_type", "=", type)
    .where("resource_key", "=", key)
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** Has this org been backfilled yet? (any claim row at all). Used to decide
 *  whether a bundle uninstall can trust the refcount. */
export async function orgHasClaims(orgId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("bundle_resource_claims")
    .select("id")
    .where("org_id", "=", orgId)
    .limit(1)
    .executeTakeFirst();
  return !!r;
}
