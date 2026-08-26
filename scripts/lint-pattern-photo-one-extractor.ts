#!/usr/bin/env tsx
// The measured score only describes the product while the scoreboard and the
// route read the SAME pages of a PDF.
//
// They did not. e2e/pattern-photo-scoreboard.mjs passed { maxPages: 12 } and
// scored the floor 26 of 26; modules/projects/src/api/pattern-photo.ts passed no
// options at all, which pdf-images.ts resolves to EVERY page, and scored 21 of
// 26 on the same corpus with the same picker and the same labels. Maker-guides
// fell from 5/5 to 2/5. The number quoted as the reason it was safe to make this
// automatic was measured on a window the shipped code did not use.
//
// A comment cannot hold that. Both sides go through extractPatternImages(), and
// this refuses any other caller of the raw extractor.
//
//   npx tsx scripts/lint-pattern-photo-one-extractor.ts

import { readFileSync } from "node:fs";

/** The only file allowed to call the raw extractor: it defines it and wraps it. */
const HOME = "modules/projects/src/api/pdf-images.ts";
/** Everyone who reads images out of a pattern PDF. Add a caller here AND make it
 *  use the wrapper — an unlisted caller is a caller nobody is checking. */
const CALLERS = ["modules/projects/src/api/pattern-photo.ts", "e2e/pattern-photo-scoreboard.mjs"];

const failures: string[] = [];
const read = (f: string) => readFileSync(f, "utf8");

let home: string;
try {
  home = read(HOME);
} catch {
  console.error(`[lint:pattern-photo-one-extractor] ✗ ${HOME} is missing.`);
  process.exit(1);
}

if (!/export const PATTERN_PDF_PAGE_LIMIT\s*=/.test(home)) {
  failures.push(`${HOME}: PATTERN_PDF_PAGE_LIMIT is gone — the page range must be one named number, not a literal at each call site.`);
}
if (!/export function extractPatternImages\(/.test(home)) {
  failures.push(`${HOME}: extractPatternImages() is gone — it is the single door the scoreboard and the route both go through.`);
}
if (!/extractPdfImages\(pdfBytes,\s*\{\s*maxPages:\s*PATTERN_PDF_PAGE_LIMIT\s*\}\)/.test(home)) {
  failures.push(`${HOME}: extractPatternImages() must apply PATTERN_PDF_PAGE_LIMIT, or the wrapper is decorative.`);
}

for (const f of CALLERS) {
  let src: string;
  try {
    src = read(f);
  } catch {
    failures.push(`${f} is missing — it is listed as a pattern-image caller.`);
    continue;
  }
  src.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*")) return;
    if (!/\bextractPdfImages\s*\(/.test(code)) return;
    failures.push(
      `${f}:${i + 1}: calls extractPdfImages directly. Use extractPatternImages() —\n` +
        `    the scoreboard and the product must read the same pages or the score is fiction.\n` +
        `    ${code.slice(0, 110)}`,
    );
  });
  if (!/extractPatternImages\s*\(/.test(src)) {
    failures.push(`${f}: never calls extractPatternImages() — is it still reading pattern images? Update CALLERS here if not.`);
  }
}

if (failures.length) {
  console.error(`[lint:pattern-photo-one-extractor] ✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:pattern-photo-one-extractor] ✓ the scoreboard and the route read the same pages");
