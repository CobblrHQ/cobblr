// LEGACY (kept for producing a standalone external index.json). As of the
// self-hosted catalog, prod no longer reads a GitHub-published index: the app
// builds the official catalog in-process from its baked-in bundle manifests and
// serves it at GET /api/v1/registry/index.json (see api/src/lib/extensions-
// index.ts). The catalog is therefore always current with the deploy — no
// manual publish. Only run this if you want to generate a static index.json to
// host elsewhere and point COBBLR_EXTENSIONS_URL at it.
//
// Regenerate the `bundles` lane of the cobblr-extensions registry index from
// the web app's embedded FEATURED_BUNDLES — the single source of truth for the
// flagship/community bundle catalog.
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
