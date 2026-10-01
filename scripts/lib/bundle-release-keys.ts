// The manifest keys that describe a RELEASE of a bundle rather than what it
// installs. Moving one of these alone is a release, never a content change, so
// it neither demands a version bump nor moves the content hash.
//
// One list, imported by lint:versions, lint:bundle-content and sync-bundles.
// Each used to keep its own copy, and a key added to one (`catalog`) had to be
// remembered in the other two by hand.
export const BUNDLE_RELEASE_KEYS = ["version", "changelog", "released_at", "releases"] as const;

// `catalog` is the offer tier (docs/design-decisions/bundle-catalog-tiers.md):
// curation, not content an installed workspace re-syncs. Demoting a bundle must
// not show every install an "update available".
export const BUNDLE_NON_CONTENT_KEYS: ReadonlySet<string> = new Set([...BUNDLE_RELEASE_KEYS, "catalog"]);

// A wire's `says` is the sentence a page shows when it suggests the bundle
// ("Works with Lists"): copy for the offer, read from the catalog, never
// installed. Rewording it must not show every install an "update available"
// that changes nothing, so it is outside the content as well.
const WIRE_COPY_KEYS: ReadonlySet<string> = new Set(["says"]);

/** The manifest as installed content: no release or curation keys at the top,
 *  and no offer copy on any wire, wherever the wire sits (the bundle's own,
 *  an instance's, a feature's). */
export function bundleContent(manifest: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) {
      return v.map((x) =>
        key === "wires" && x && typeof x === "object"
          ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k]) => !WIRE_COPY_KEYS.has(k)).map(([k, y]) => [k, strip(y, k)]))
          : strip(x, null),
      );
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, y]) => [k, strip(y, k)]));
    return v;
  };
  return strip(Object.fromEntries(Object.entries(manifest).filter(([k]) => !BUNDLE_NON_CONTENT_KEYS.has(k))), null) as Record<string, unknown>;
}
