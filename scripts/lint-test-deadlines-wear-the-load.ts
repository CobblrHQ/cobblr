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
// WIDENED (2026-10-08, the same night): main went red on pattern-photo-auto, whose waits escaped both
// shapes above: a `timeoutMs = 45_000` default parameter and a fixed `}, 60_000)` test budget around
// two such waits. A timeout* variable, a test's own budget (`}, <ms>)` of 1000 or more, closing an
// it/hook) and `timeout: <ms>` in a test's options all scale with the box too.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `new Date(Date.now() + 29 * DAY)` is a DATE the
// test sends (a sweep 29 days out, a token's expiry), not a wait, and appears 26 times in api/tests:
// that is why the rule keys on the deadline names and not on `Date.now() +` itself. A poll against a
// deadline named something else escapes it; none did on 2026-10-08.
//
// THE OTHER BOUNDARY: a line that asserts (expect(...), toHaveBeenCalledWith(...)) is checking a value
// the code under test passed, not waiting; wearing it makes the test disagree with the code.
//
// PROVE IT RED: it was run against the eight fixed deadlines on main and failed on each.
//
//   npx tsx scripts/lint-test-deadlines-wear-the-load.ts   (pnpm lint test-deadlines-wear-the-load)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests", "api/src", "scripts"]; // api/src: its unit tests live beside the code since #5443

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
    else if (/\.test\.tsx?$/.test(name) || (/^api\/tests\//.test(p) && /\.ts$/.test(name))) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/\/ fixed-deadline: \S/.test(line)) continue;
    // An ASSERTED value is not a wait: `toHaveBeenCalledWith(path, {timeout: 10_000})` checks what the
    // code passed, and wearing it made the expectation disagree with the code (#5429, red 2026-10-09).
    if (/\bexpect\(|\.(?:toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|toEqual|toStrictEqual|toMatchObject|toBe)\(/.test(line)) continue;
    if (/\b(?:deadline|until|end|stop)\w*\s*=\s*Date\.now\(\)\s*\+\s*[0-9]/i.test(line)) {
      out.push({ file, line: i + 1, what: "a polling deadline that does not scale with the box: Date.now() + worn(ms)" });
    } else if (/\btimeout\w*\s*=\s*[0-9][0-9_]*\b/i.test(line)) {
      out.push({ file, line: i + 1, what: "a timeout that does not scale with the box: worn(ms)" });
    } else if (/^\s*\},\s*[0-9][0-9_]{3,}\s*\);?\s*(\/\/.*)?$/.test(line) || /\btimeout:\s*[0-9][0-9_]{3,}\b/.test(line)) {
      out.push({ file, line: i + 1, what: "a test's own time budget that does not scale with the box: worn(ms) (or a named budget such as FRESH_ORG_BUDGET_MS)" });
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
