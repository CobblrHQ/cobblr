#!/usr/bin/env tsx
// A scan inbox row, item screen or session strip draws its words in the app's own face: font-mono only on a code, an id or a barcode's digits, with a mono: line saying which, or on an uppercase label.
//
// THE BUG THIS PREVENTS. The owner, 2026-10-12 (#6099): 'Orion Fans · Den' and 'Add barcode' in a code font on the strip and the item screen, again
//
// Nothing held it before: the row's subtitle, the item screen's meta line and
// the Add barcode chip carried font-mono from their first drafts, and no rule
// said what the code font is for.
//
// THE RULE. In the inbox row, the item screen, the session strip and the
// match banner, a line with font-mono passes when it is an uppercase label
// (the eyebrow style: "PICTURES", "CATALOG"), or when it or the line above
// says `mono: <what it is>` (a barcode's digits, a tracking number, a hex
// code). Anything else is words in a code font, and fails.
//
// THE BOUNDARY. These five files are the scan inbox's rows, where the owner
// read it; the app has some 560 other code-font uses (an id in a modal, a
// rule's JSON), each a code, and judging them is not this rule's to do.
//
// PROVE IT RED: run on main, it fails on ScanInboxCard's subtitle and Add
// barcode chip, ScanItemScreen's meta line and ScanPhoneRow's subtitle.
//
//   npx tsx scripts/lint-scan-meta-not-monospace.ts   (pnpm lint scan-meta-not-monospace)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src"];
const FILES = new Set(["ScanInboxCard.tsx", "ScanItemScreen.tsx", "ScanPhoneRow.tsx", "ScanPage.tsx", "TrackedMatchBanner.tsx"]);

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bfont-mono\b/.test(line)) continue;
    if (/\buppercase\b/.test(line)) continue;
    if (/mono: \S/.test(line) || /mono: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "words in a code font: font-mono with no mono: <what it is> line" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS)
  for (const file of walk(root)) if (FILES.has(file.split("/").pop() ?? "")) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-meta-not-monospace - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Drop font-mono from words; keep it on the digits, with a // mono: <what> line above");
  process.exit(1);
}
console.log(`lint:scan-meta-not-monospace OK`);
