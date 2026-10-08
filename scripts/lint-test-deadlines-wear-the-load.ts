#!/usr/bin/env tsx
// A test that polls against a deadline scales it with the box (Date.now() + worn(ms)), because its own budget does and a fixed deadline on a loaded box gives up first
//
// THE BUG THIS PREVENTS. 2026-10-08: power-off-after-this-print polled 20 s while its budget was worn(60 s); on a box at 2.1 load per core the control was not done by then, on the try and the retry, and #5344 went red
//
// THE RULE. In a test file (*.test.ts under api/tests or scripts), a variable named for a deadline
// (deadline, until, end, stop, and longer names starting with them) set to `Date.now() + <number>` is
// a violation; `Date.now() + worn(<number>)` passes. A deadline that must not scale says why on the
// line: `// fixed-deadline: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `new Date(Date.now() + 29 * DAY)` is a DATE the
// test sends (a sweep 29 days out, a token's expiry), not a wait, and appears 26 times in api/tests:
// that is why the rule keys on the deadline names and not on `Date.now() +` itself. A poll against a
// deadline named something else escapes it; none did on 2026-10-08.
//
// PROVE IT RED: it was run against the eight fixed deadlines on main and failed on each.
//
//   npx tsx scripts/lint-test-deadlines-wear-the-load.ts   (pnpm lint test-deadlines-wear-the-load)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests", "scripts"];

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
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\b(?:deadline|until|end|stop)\w*\s*=\s*Date\.now\(\)\s*\+\s*[0-9]/i.test(line) && !/\/\/ fixed-deadline: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "a polling deadline that does not scale with the box: Date.now() + worn(ms)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-deadlines-wear-the-load - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Date.now() + worn(<ms>), worn from scripts/lib/load-factor.mjs");
  process.exit(1);
}
console.log(`lint:test-deadlines-wear-the-load OK`);
