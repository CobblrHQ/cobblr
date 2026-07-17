// Bundle catalog tiering — the pure classifier + scope predicate. Kept in its
// own env-free module (no fs, no registry, no db) so a unit test can import it
// without dragging in the env-validating chain that flagship-bundles.ts pulls
// through registry.ts. flagship-bundles.ts re-exports these.
//
//   core     — suggested per-scan AND browsable in the marketplace
//   extended — browsable, but NOT suggested per-scan (surfaces only when a user
//              goes looking); keeps overlapping bundles from competing on every scan
//   disabled — hidden everywhere; existing installs keep working (only the OFFER
//              is withdrawn, never the data)

export type CatalogTier = "core" | "extended" | "disabled";
export type CatalogScope = "offerable" | "suggested" | "all";

/** A bundle's tier, defaulting to `core` — including for a garbage value, so a
 *  typo can never silently HIDE a bundle. */
export function catalogTier(m: Record<string, unknown>): CatalogTier {
  const v = m.catalog;
  return v === "extended" || v === "disabled" ? v : "core";
}

/** Is a manifest visible in this scope? The ONE predicate `listFlagshipManifests`
 *  filters with, so the marketplace and the scan menu can't drift apart:
 *   - `suggested` (per-scan capture menu): core only.
 *   - `offerable` (marketplace/registry): core + extended, minus disabled.
 *   - `all` (tests/admin): everything. */
export function inCatalogScope(m: Record<string, unknown>, scope: CatalogScope): boolean {
  if (scope === "all") return true;
  const t = catalogTier(m);
  return scope === "suggested" ? t === "core" : t !== "disabled";
}
