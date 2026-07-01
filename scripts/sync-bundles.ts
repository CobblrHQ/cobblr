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
//   • leaves non-featured files (companion app-compat, …) untouched.
//
// Run:  npx tsx scripts/sync-bundles.ts        (rerun whenever featured-bundles changes)
// Lint: scripts/lint-versions.ts enforces the bump; CI runs it.
import { FEATURED_BUNDLES } from "../web/src/lib/featured-bundles.js";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "bundles");

function slugOf(id: string): string {
  return id.replace(/^cobblr\.(flagship|community)\./, "").replace(/[^a-z0-9-]/gi, "-");
}

/** Content signature excluding the release-metadata keys (mirrors lint-versions). */
function sig(manifest: Record<string, unknown>): string {
  const { version: _v, changelog: _c, released_at: _r, ...rest } = manifest;
  return JSON.stringify(rest);
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
for (const fb of FEATURED_BUNDLES) {
  const manifest = JSON.parse(JSON.stringify(fb.manifest)) as Record<string, unknown>;
  const id = String(manifest.id ?? "");
  if (!id.startsWith("cobblr.")) continue;
  const file = path.join(OUT, `${slugOf(id)}.json`);
  const existing = fs.existsSync(file)
    ? ((JSON.parse(fs.readFileSync(file, "utf8")) as { manifest?: Record<string, unknown> }).manifest ?? null)
    : null;
  if (existing && sig(existing) === sig(manifest)) { unchanged++; continue; }
  if (existing) {
    // Content changed → the emitted version must move past the existing file's
    // (installed workspaces upgrade off THESE files, not the web bundle's).
    const exVer = String(existing.version ?? "0.0.0");
    const webVer = String(manifest.version ?? "0.0.0");
    if (cmpVer(webVer, exVer) <= 0) manifest.version = bumpPatch(exVer);
  }
  fs.writeFileSync(file, JSON.stringify({ manifest }, null, 2) + "\n");
  console.log(`wrote ${path.basename(file)}  v${manifest.version}${existing ? ` (was ${existing.version})` : " (new)"}`);
  wrote++;
}
console.log(`\n${wrote} written, ${unchanged} already in sync.`);
