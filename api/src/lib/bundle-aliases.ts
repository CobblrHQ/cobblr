// Bundle ids that were RENAMED, and what they are now.
//
// A bundle's external_id is identity, so the 2026-08-09 naming pass migrated it
// everywhere it is a column: `bundles.external_id`,
// `bundle_resource_claims.source`, `core_catalogs_catalogs.bundle_external_id`
// (see api/migrations/platform/20260809-098-bundle-id-renames.sql).
//
// It is not always a column. A scan capture records its matched bundle INSIDE
// `core_scan_inbox_items.suggested_candidates`, a jsonb blob, and that the
// migration did not reach. So a capture taken before the rename still points at
// a retired id, with two visible consequences (reported 2026-08-11):
//
//   * the dashboard suggestion rendered the raw id, because no manifest answers
//     to it — "6 look like cobblr.flagship.food-cluster — install";
//   * that button would then try to install a bundle that no longer exists.
//
// Resolving at the read boundary rather than rewriting the jsonb fixes both for
// every workspace at once, needs no migration, and keeps working for any capture
// that was already in flight. Old ids never come back, so this map only grows.
//
// KEEP IN SYNC WITH THE MIGRATION. bundle-aliases.test.ts parses the SQL and
// fails if the two disagree, so a future rename cannot land in one and not the
// other.

export const RENAMED_BUNDLE_IDS: Readonly<Record<string, string>> = Object.freeze({
  "cobblr.flagship.food-cluster": "cobblr.flagship.groceries",
  "cobblr.flagship.pet-care": "cobblr.flagship.pets",
  "cobblr.flagship.plant-care": "cobblr.flagship.plants",
  "cobblr.flagship.vehicle-maintenance": "cobblr.flagship.vehicles",
  "cobblr.flagship.documents-renewals": "cobblr.flagship.documents",
  "cobblr.flagship.warranties-receipts": "cobblr.flagship.warranties",
  "cobblr.flagship.filament-stash": "cobblr.flagship.filament",
  "cobblr.flagship.kitchen-fitness": "cobblr.flagship.grocery-spend",
});

/** The id a retired one became, or the id itself when it was never renamed.
 *  Safe to call on anything, including ids from other namespaces. */
export function currentBundleId(id: string): string {
  return RENAMED_BUNDLE_IDS[id] ?? id;
}

/** A readable name for a bundle this build has no manifest for — an extension,
 *  a rolled-back catalog, anything unknown. The point is only that a dotted
 *  namespaced id never reaches a user: "cobblr.flagship.household-supplies"
 *  becomes "Household Supplies". Manifest names always win over this. */
export function humaniseBundleId(id: string): string {
  const last = id.split(".").pop() ?? id;
  const words = last
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ") : id;
}
