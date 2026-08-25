#!/usr/bin/env tsx
// The wordmark is "Cobblr", capital C — decided 2026-08-25 (BRAND.md §5).
//
// It is rendered as a plain string, and there are SIX independent render sites
// (app sidebar, mobile nav, auth page, join page, public surface, the managed-
// app header). That is exactly how the casing drifted the first time: the
// doctrine said lowercase, the homepage shipped capital, and the app shell kept
// lowercase for months because nothing connected the sites to the decision.
// A sticker print run is what finally forced the call.
//
// So: no JSX text node or user-facing string literal may render the bare brand
// name in lowercase. URLs (cobblr.xyz), scheme/package/repo identifiers
// (@cobblr/*, cobblr-*, core-*), and prose ABOUT the old casing in comments are
// all fine — this only polices what a user sees.
//
//   cd <repo> && npx tsx scripts/lint-wordmark-casing.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "packages/platform-web/src"];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx|ts)$/.test(p)) acc.push(p);
  }
  return acc;
}

// A lowercase "cobblr" that stands alone as rendered text:
//   >cobblr<        a JSX text node (possibly with whitespace/newlines)
// Identifiers, URLs and imports all attach the name to more characters
// (cobblr.xyz, @cobblr/, cobblr-edge, tenant_cobblr), so requiring the bare
// word between JSX brackets keeps them out without a denylist.
const BARE_TEXT_NODE = />\s*cobblr\s*</;

const bad: string[] = [];
for (const root of ROOTS) {
  for (const f of walk(root)) {
    const src = readFileSync(f, "utf8");
    if (!BARE_TEXT_NODE.test(src)) continue;
    src.split("\n").forEach((line, i) => {
      if (BARE_TEXT_NODE.test(line) || /^\s*cobblr\s*$/.test(line)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
    });
    // multi-line JSX: the bare word alone on its own line between tags
    src.split("\n").forEach((line, i) => {
      if (/^\s*cobblr\s*$/.test(line)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
}

const unique = [...new Set(bad)];
if (unique.length) {
  console.error("lint-wordmark-casing: the wordmark is \"Cobblr\" (BRAND.md §5, decided 2026-08-25).");
  console.error("These render it lowercase to users:\n");
  for (const b of unique) console.error("  " + b);
  process.exit(1);
}
console.log("lint-wordmark-casing: ok");
