#!/usr/bin/env tsx
// One rule decides which scan photo leads — and it lives in
// web/src/lib/scanPhoto.ts, nowhere else.
//
// A scan item carries catalog art, the user's own photo, and a local frame.
// While the server cross-checks the catalog art against the user's photo, the
// user's photo must lead (a collided/spam UPC resolves to junk, and leading
// with unverified art reads as "the scanner failed"). That rule got
// reimplemented inline on SEVEN surfaces and only two knew about the check, so
// the result sheet's photo strip announced the catalog shot as the "Display
// photo" while the image right above it deliberately showed the user's own
// (the author, 2026-08-04). Surfaces that answer the same question separately drift.
//
// So: any file that picks between `catalog_image_*` and `image_file_id` must go
// through leadPhoto()/photoOrder(). This flags an inline ladder — a file that
// mentions a catalog image source AND the user's own, without importing the
// helper.
//
//   cd <repo> && npx tsx scripts/lint-scan-photo-lead.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src"];
/** The helper itself, and its test. */
const EXEMPT = ["web/src/lib/scanPhoto.ts", "web/src/lib/scanPhoto.test.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const failures: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = file.replace(/\\/g, "/");
    if (EXEMPT.includes(rel)) continue;
    const src = readFileSync(file, "utf8");
    // Property ACCESSES only (`it.catalog_image_url`, `?.catalog_image_file_id`).
    // A type declaration (`catalog_image_url: string | null;`) chooses nothing,
    // and api.ts must keep declaring the fields.
    const usesCatalog = /[.?]catalog_image_(file_id|url)\b/.test(src);
    const usesOwn = /[.?]image_file_id\b/.test(src);
    if (!usesCatalog || !usesOwn) continue; // not choosing between them
    if (/from "[^"]*lib\/scanPhoto"/.test(src)) continue; // goes through the rule
    const line = src.split("\n").findIndex((l) => /[.?]catalog_image_(file_id|url)\b/.test(l)) + 1;
    failures.push(
      `${rel}:${line} picks between catalog art and the user's photo without lib/scanPhoto\n` +
        `    → use leadPhoto(item, {catalog: [...], yours, frame}) / photoOrder(item).\n` +
        `      Inline ladders miss the cross-check and claim art is showing when it is not.`,
    );
  }
}

if (failures.length) {
  console.error(`[lint:scan-photo-lead] ✗ ${failures.length} inline image ladder(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:scan-photo-lead] ✓ every scan-photo choice goes through lib/scanPhoto");
