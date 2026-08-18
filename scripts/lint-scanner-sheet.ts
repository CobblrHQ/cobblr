#!/usr/bin/env tsx
/**
 * lint:scanner-sheet — the camera's result sheet keeps its shape, and its ＋
 * means add.
 *
 * Two bugs found by hand in one session, both invisible to the 25 existing
 * `e2e/scan-*.mjs` files because both live in a TRANSITION rather than a state:
 *
 * 1. The photo strip was gated on `item`, which is null for the ~3s the ingest
 *    runs. So "Looking up…" had no strip and no ＋, and then both appeared: the
 *    sheet reflowed under your thumb and the ＋ arrived exactly where you were
 *    about to tap. A test that checks "the strip exists" AFTER settle passes
 *    this happily.
 *
 * 2. The strip's ＋ armed "catalog" for anything that was not already a photo
 *    scan. `catalog` calls setScanCatalogFile — it REPLACES the display photo
 *    rather than adding to the strip — so on a barcode scan the shot did not
 *    appear where the tooltip said it would ("your next shot attaches") and the
 *    drawer came back looking like a different scan.
 *
 * Both are shape rules, so they are checkable at the source and cost nothing in
 * CI. A render-level matrix would be better and needs a DOM test stack this
 * repo does not carry yet.
 *
 * Run: npx tsx scripts/lint-scanner-sheet.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SHEET = "web/src/pages/ScanResultModal.tsx";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const findings: string[] = [];

// ── 1. the strip is not gated on the row existing ────────────────────────
const sheet = read(SHEET);
const STRIP = 'flex items-center gap-1.5';
const stripAt = sheet.indexOf(STRIP);
if (stripAt < 0) {
  findings.push(
    `  ${SHEET}  the photo strip container was not found — this lint is keyed to it.\n` +
      `      If it moved, re-point the lint rather than deleting it.`,
  );
} else {
  // What opens the element the strip lives on. A conditional on `item` here is
  // the bug: the whole strip disappears for the duration of the lookup.
  const before = sheet.slice(Math.max(0, stripAt - 400), stripAt);
  if (/\{\s*item\s*&&\s*\(\s*$/.test(before.replace(/\s+$/, "$&"))) {
    findings.push(
      `  ${SHEET}  the photo strip is gated on \`item\`, so it does not exist while the\n` +
        `      ingest runs — the sheet changes shape mid-scan. Render it always and\n` +
        `      guard the individual tiles.`,
    );
  }
  // And it must say something during the wait rather than being an empty row.
  const strip = sheet.slice(stripAt, stripAt + 2500);
  if (!/!item\s*&&/.test(strip)) {
    findings.push(
      `  ${SHEET}  the strip has no placeholder for the pending state. An empty row is\n` +
        `      the same reflow in a different costume — give it a skeleton tile.`,
    );
  }
}

// Rule 2 (the ＋ must arm "append") was REMOVED on 2026-08-17. It encoded a
// change that contradicted a settled decision: scan-photo-wanted.md records
// that "display image, or another angle?" is closed, the answer is display
// image, and re-opening it was the mistake. A lint that enforces the wrong
// answer is worse than none — it makes the correct code fail.
//
// What remains is rule 1, which is about SHAPE and holds regardless of which
// mode the ＋ arms.

if (findings.length) {
  console.error(`❌ ${findings.length} scanner-sheet rule(s) broken:\n`);
  console.error(findings.join("\n\n"));
  console.error(
    "\nFound by hand, not by the 25 e2e/scan-*.mjs files, because it lives in a\n" +
      "TRANSITION rather than a state. The render-level matrix is in\n" +
      "web/src/pages/ScanResultModal.matrix.test.tsx.",
  );
  process.exit(1);
}
console.log("scanner-sheet lint: clean");
