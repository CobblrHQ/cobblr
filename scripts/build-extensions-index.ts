// Regenerate the `bundles` lane of the cobblr-extensions registry index from
// the web app's embedded FEATURED_BUNDLES — the single source of truth for the
// flagship/community bundle catalog. The marketplace is registry-backed (it
// reads this index.json via the GitHub contents API), so after editing
// web/src/lib/featured-bundles.ts you MUST run this + push the index, or prod
// keeps serving the stale catalog (the embedded list is only a fallback when
// the registry is unreachable).
//
// Preserves the other lanes (drivers / modules / renderers / trusted_keys) and
// top-level fields untouched — only `bundles` is rebuilt.
//
// Usage:
//   npx tsx scripts/build-extensions-index.ts <path-to-cobblr-extensions/index.json>
//   (then commit + push that index.json to CobblrHQ/cobblr-extensions)

import { readFileSync, writeFileSync } from "node:fs";
import { FEATURED_BUNDLES } from "../web/src/lib/featured-bundles";

const indexPath = process.argv[2];
if (!indexPath) {
  console.error("usage: npx tsx scripts/build-extensions-index.ts <index.json>");
  process.exit(1);
}

const idx = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;

idx.bundles = FEATURED_BUNDLES.map((b) => ({
  id: b.manifest.id,
  name: b.manifest.name,
  version: b.manifest.version,
  description: b.manifest.description ?? "",
  author: b.manifest.author ?? "",
  glyph: b.glyph,
  blurb: b.blurb,
  requires: (b.manifest.requires ?? []).map((r) => r.module),
  manifest: b.manifest,
}));

writeFileSync(indexPath, JSON.stringify(idx, null, 2) + "\n");
console.log(`regenerated ${(idx.bundles as unknown[]).length} bundles → ${indexPath}`);
