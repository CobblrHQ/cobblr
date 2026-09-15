#!/usr/bin/env tsx
// Every insert into core_scan_inbox_items goes through services/intake.ts intakeRow, so no door can admit a row without its shape's plan
//
// THE BUG THIS PREVENTS. A model number typed into the dashboard's box sat in
// the inbox with no name, no picture and no identify (#3049, 2026-09-15):
// POST /scan/note inserted its row and ran the matchmaker alone, while the
// same string scanned as a barcode got the catalog, the web, the picture and
// the photo cross-check. Six doors each decided for themselves what the
// pipeline does with a row, so every door was a chance to forget a pass.
//
// THE RULE. The inbox has ONE insert, in modules/core-scan/src/services/
// intake.ts (intakeRow: the row's shape, its plan, the passes in order). A
// door hands intakeRow its values; it never inserts. So an
// insertInto("core_scan_inbox_items") anywhere else in the module, the api
// or another module fails here. A raw SQL insert into the table fails too.
// There is no opt-out: a row that needs no pass is a shape whose plan is
// empty (the import), declared in the table, not skipped at a door.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified. Red first on the five inserts of
// main at 5611bc454 (the scan, the note, the receipt lines, the split, the
// import); COBBLR_LINT_ROOT=<a checkout> points it at another tree.
//
//   npx tsx scripts/lint-scan-door-intake.ts   (pnpm run lint:scan-door-intake)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["api/src", "modules"].map((r) => join(BASE, r));
const THE_DOOR = /modules\/core-scan\/src\/services\/intake\.ts$/;

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
  if (THE_DOOR.test(file)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/insertInto\(\s*["'`]core_scan_inbox_items["'`]\s*\)/.test(line)) {
      out.push({ file, line: i + 1, what: "an insert into core_scan_inbox_items outside services/intake.ts; hand intakeRow the values instead" });
    }
    if (/insert\s+into\s+core_scan_inbox_items\b/i.test(line)) {
      out.push({ file, line: i + 1, what: "a raw SQL insert into core_scan_inbox_items; hand intakeRow the values instead" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-door-intake - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:scan-door-intake OK`);
