// Sync bundles/*.json from web/src/lib/featured-bundles.ts — the ONE source.
//
// The trap this kills: bundle manifests live in TWO places (featured-bundles.ts
// for the web catalog, bundles/*.json for the server's capture-first menu +
// quickstart install), and they DRIFTED — every bundles/*.json except yarn was
// the old field_defs-only shape with no provides_instances, so the capture-first
// menu had no item_nouns ("kitchen & groceries" as the noun instead of the
// instance nouns) and the heuristic matched almost nothing for new users.
//
// This script regenerates bundles/<slug>.json from FEATURED_BUNDLES:
//   • flagship AND community bundles (community were missing entirely — "LEGO
//     set" couldn't suggest the Lego bundle, "M3 screws" couldn't suggest
//     Printer Parts);
//   • preserves the version contract (lint-versions): when content changed but
//     the web version didn't move past the existing file's, the patch version is
//     bumped over the EXISTING file's so installed workspaces see the upgrade;
//   • leaves non-featured files untouched.
//
// Run:  npx tsx scripts/sync-bundles.ts          (rerun whenever featured-bundles changes)
// Check: npx tsx scripts/sync-bundles.ts --check  (CI/pre-push: fail if a bundles/*.json
//        is out of sync with the source — someone edited the GENERATED json directly, or
//        edited featured-bundles.ts but didn't re-run the sync). See lint:bundles-synced.
// Lint: scripts/lint-versions.ts enforces the version bump; CI runs it.
import { FEATURED_BUNDLES } from "../web/src/lib/featured-bundles.js";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "bundles");
const CHECK = process.argv.includes("--check");

function slugOf(id: string): string {
  return id.replace(/^cobblr\.(flagship|community)\./, "").replace(/[^a-z0-9-]/gi, "-");
}

/** Content signature excluding the release-metadata keys (mirrors lint-versions). */
function sig(manifest: Record<string, unknown>): string {
  const { version: _v, changelog: _c, released_at: _r, ...rest } = manifest;
  return JSON.stringify(rest);
}

// The VERSION-BUMP signature also ignores `catalog` (the offer tier). Demoting a
// bundle is a curation change, not content an installed workspace re-syncs, so it
// must NOT bump the version — a bump would show every existing install an "update
// available" for the bundle you're disabling. So a catalog-only edit still
// rewrites the json (sig differs → the field lands) but keeps the version.
function bumpSig(manifest: Record<string, unknown>): string {
  const { catalog: _cat, ...rest } = manifest;
  return sig(rest);
}

function bumpPatch(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return v + ".1";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

let wrote = 0, unchanged = 0;
const drifted: string[] = [];
for (const fb of FEATURED_BUNDLES) {
  const manifest = JSON.parse(JSON.stringify(fb.manifest)) as Record<string, unknown>;
  const id = String(manifest.id ?? "");
  if (!id.startsWith("cobblr.")) continue;
  const file = path.join(OUT, `${slugOf(id)}.json`);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const existing = raw
    ? ((JSON.parse(raw) as { manifest?: Record<string, unknown> }).manifest ?? null)
    : null;
  // Version continuity FIRST, then compare the byte-exact expected output.
  // Comparing sig() alone missed two real cases (found 2026-08-07): a
  // metadata-only edit (released_at/changelog, which sig excludes) never
  // reached the generated file, and a malformed wrapper (a stray top-level
  // key beside "manifest") was never cleaned because the inner manifests
  // matched.
  if (existing) {
    if (bumpSig(existing) !== bumpSig(manifest)) {
      // Real content changed → the emitted version must move past the existing
      // file's (installed workspaces upgrade off THESE files, not the web bundle's).
      const exVer = String(existing.version ?? "0.0.0");
      const webVer = String(manifest.version ?? "0.0.0");
      if (cmpVer(webVer, exVer) <= 0) manifest.version = bumpPatch(exVer);
    } else {
      // Offer tier / release metadata only — keep the installed version untouched.
      manifest.version = String(existing.version ?? manifest.version ?? "0.0.0");
    }
  }
  const out = JSON.stringify({ manifest }, null, 2) + "\n";
  if (raw === out) { unchanged++; continue; }
  // Out of sync: the generated json doesn't match the source. Either someone
  // hand-edited the GENERATED bundles/*.json (it's an artifact, not a source —
  // edit featured-bundles.ts) or edited the source and didn't re-sync.
  if (CHECK) { drifted.push(`${slugOf(id)}.json${existing ? "" : " (missing)"}`); continue; }
  fs.writeFileSync(file, out);
  console.log(`wrote ${path.basename(file)}  v${manifest.version}${existing ? ` (was ${existing.version})` : " (new)"}`);
  wrote++;
}

if (CHECK) {
  if (drifted.length > 0) {
    console.error(
      `[lint:bundles-synced] ✗ ${drifted.length} bundle(s) out of sync with web/src/lib/featured-bundles.ts:\n` +
        drifted.map((d) => `  - bundles/${d}`).join("\n") +
        `\n\nbundles/*.json are GENERATED. Edit the manifest in web/src/lib/featured-bundles.ts,\n` +
        `then run:  npx tsx scripts/sync-bundles.ts   and commit the regenerated json.`,
    );
    process.exit(1);
  }
  console.log("[lint:bundles-synced] ✓ all bundles/*.json in sync with featured-bundles.ts");
} else {
  console.log(`\n${wrote} written, ${unchanged} already in sync.`);
}
