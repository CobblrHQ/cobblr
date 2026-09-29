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
