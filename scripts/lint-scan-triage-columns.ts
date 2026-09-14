#!/usr/bin/env tsx
// A core-scan select that feeds a row to the scan-triage predicates spreads SCAN_TRIAGE_COLUMNS, so a column a predicate starts reading is never left out of one select and read there as nothing flagged.
//
// THE BUG THIS PREVENTS. the review predicate began reading the route (source check, #3008) and two selects (inbox/stats, organize) listed the triage columns by hand without it, so a contradicted row counted as ready there and flagged in the list (2026-09-14)
//
// THE RULE. In a core-scan source file that calls one of the scan-triage
// predicates (needsScanReview, matchesScanFacet, isScanReadyToFile,
// scanReviewReason, scanReviewSourceConflict), every `.select([...])` whose
// column list names "ai_confidence" (the tell of a hand-listed triage read)
// must spread `...SCAN_TRIAGE_COLUMNS`. A select that reads whole rows
// (`selectAll()`) passes; a select in a file that never judges a row passes;
// a select that lists the columns by hand fails, because the predicates read
// `suggested_candidates` now and will read another column later, and a
// hand-written list cannot know. A genuine exception opts out with
// `// TRIAGE-COLUMNS OK: <reason>` on the `.select([` line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-scan-triage-columns.ts   (pnpm run lint:scan-triage-columns)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/core-scan/src"];

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

const PREDICATES = /\b(needsScanReview|matchesScanFacet|isScanReadyToFile|scanReviewReason|scanReviewSourceConflict)\(/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!PREDICATES.test(src)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\.select\(\[/.test(line)) continue;
    if (/\/\/ TRIAGE-COLUMNS OK: /.test(line)) continue;
    // The literal runs to its closing bracket, possibly over many lines.
    let body = "";
    for (let j = i; j < lines.length; j++) {
      body += (lines[j] ?? "") + "\n";
      if (/\]\)/.test(lines[j] ?? "")) break;
    }
    if (!/"ai_confidence"/.test(body)) continue;
    if (/\.\.\.SCAN_TRIAGE_COLUMNS/.test(body)) continue;
    out.push({ file, line: i + 1, what: "a triage read lists its columns by hand; spread ...SCAN_TRIAGE_COLUMNS" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-triage-columns - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Replace the hand-listed triage columns with ...SCAN_TRIAGE_COLUMNS from @cobblr/platform-contract/scan-triage.");
  process.exit(1);
}
console.log(`lint:scan-triage-columns OK`);
