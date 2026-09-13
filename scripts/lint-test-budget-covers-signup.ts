#!/usr/bin/env tsx
// An api test in a file that signs up a workspace never passes a per-test
// timeout below FRESH_ORG_BUDGET_MS, the signup helper's own worst case; the
// budget comes from the helper, not a stopwatch.
//
// THE BUG THIS PREVENTS. api/tests/attention.test.ts timed out at 30 s on
// both attempts in the post-merge gate on main and blocked a deploy (#2867).
// Its header already recorded three earlier flakes of the same shape. The
// helper takes a pooled workspace when there is one, but a full suite empties
// the pool and the fallback is a CREATE DATABASE behind the template lock
// plus every module enabled in waves: 5 to 45 s on a loaded runner. The
// suite's global testTimeout is 60 s for that reason; the file overrode it
// with 30_000, a number someone once measured on a quiet box.
//
// THE RULE. In api/tests/*.test.ts, a file that imports signupFreshOrg from
// ./helpers may not close an it()/test() with a numeric timeout smaller than
// FRESH_ORG_BUDGET_MS (read from api/tests/helpers.ts, so the two cannot
// drift). Write the constant instead: `}, FRESH_ORG_BUDGET_MS);`. A test
// that genuinely wants a tighter clock on a body that does not sign up says
// so on the closing line: `}, 5_000); // budget: <why the signup is elsewhere>`.
//
// PROVEN RED on attention.test.ts (two 30_000), scan-eval-capture.test.ts
// (30000) and undo-at-once-voids-the-purchase.test.ts (20_000) as they were;
// green once each closed with the constant.
//
//   npx tsx scripts/lint-test-budget-covers-signup.ts   (pnpm run lint:test-budget-covers-signup)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];
const HELPERS = "api/tests/helpers.ts";
const BUDGET = (() => {
  const m = readFileSync(HELPERS, "utf8").match(/export const FRESH_ORG_BUDGET_MS\s*=\s*([0-9_]+)/);
  if (!m) throw new Error(`${HELPERS} no longer exports FRESH_ORG_BUDGET_MS; this lint reads the budget from there`);
  return Number(m[1]!.replace(/_/g, ""));
})();
/** The closing of an it()/test() body with a numeric timeout: `}, 30_000);` */
const CLOSE_WITH_BUDGET = /^\s*\}\s*,\s*([0-9][0-9_]*)\s*\)\s*;/;

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
    else if (/\.test\.ts$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\bsignupFreshOrg\b/.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(CLOSE_WITH_BUDGET);
    if (!m) continue;
    const ms = Number(m[1]!.replace(/_/g, ""));
    if (ms >= BUDGET) continue;
    if (/\/\/ budget: \S/.test(line)) continue;
    out.push({
      file,
      line: i + 1,
      what: `a per-test budget of ${ms} ms in a file that signs up a workspace, below the helper's worst case (${BUDGET} ms); close with FRESH_ORG_BUDGET_MS from ./helpers, or say why the clock is tighter: // budget: <reason>`,
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-budget-covers-signup - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:test-budget-covers-signup OK`);
