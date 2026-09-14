#!/usr/bin/env tsx
// A wall-clock bound in api/tests goes through wallClock().expectWithin, so a
// miss on a loaded runner is INCONCLUSIVE and never red; a raw toBeLessThan on
// an elapsed time is refused.
//
// THE BUG THIS PREVENTS (#3025). `expect(took).toBeLessThan(15_000)` on a
// delete drain went red on main for a commit that moved one file: the runner
// was at load 17 on 12 cores (three docker builds, the tracker lane and the
// test job on one box) and the 5 s drain took 25 s. The bound measured the
// box. Widening it would hide the regression it exists to catch; sending the
// case through api/tests/wall-clock.ts makes a miss under load a skip with the
// load in its reason, and a miss on a quiet box the failure it is.
//
// THE RULE. In api/tests/*.test.ts, a file that reads a clock (`Date.now()`,
// `performance.now()`) must not assert an upper bound with toBeLessThan /
// toBeLessThanOrEqual directly; it uses `wallClock().expectWithin(ctx, ms,
// why)` or `expectElapsedWithin(ctx, took, ms, why)` from ./wall-clock.js. An
// upper bound on something that is not a duration (a count, a timestamp
// sanity check) in such a file opts out on the line with
// `ALLOW-RAW-BOUND: <what it measures>`.
//
// PROVE IT RED before you trust it green: put `expect(Date.now() - t0)
// .toBeLessThan(1000)` in a test file, run it, watch it fail, take it out.
//
//   npx tsx scripts/lint-wall-clock-assertions.ts   (pnpm run lint:wall-clock-assertions)
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";
// A file that reads a clock and asserts an UPPER bound is where a wall-clock
// bound hides, whatever the operands are called (`answeredAt - started`
// evaded a narrower pattern). Lower bounds are counts, never wall clocks.
const ELAPSED = /Date\.now\(\)|performance\.now\(\)/;
const BOUND = /\.(toBeLessThan|toBeLessThanOrEqual)\(/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

const violations: Violation[] = [];
for (const file of sourceFiles("api/tests/*.test.ts")) {
  const src = readFileSync(file, "utf8");
  if (!ELAPSED.test(src)) continue;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!BOUND.test(line)) continue;
    if (/ALLOW-RAW-BOUND:\s*\S/.test(line)) continue;
    violations.push({ file, line: i + 1, what: "a numeric bound in a file that measures elapsed time; use wallClock().expectWithin(ctx, ms, why), or mark a non-duration with ALLOW-RAW-BOUND: <what>" });
  }
}

if (violations.length) {
  console.error(`lint:wall-clock-assertions - ${violations.length} raw bound(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    `\n  A wall-clock bound measures the runner as much as the code (#3025: a 5s drain took\n` +
      `  25s at load 17 on 12 cores and main went red on a file move). wallClock().expectWithin\n` +
      `  makes a miss under load INCONCLUSIVE with the load in its reason, and keeps a miss on a\n` +
      `  quiet box red. The bound is never widened for the box.`,
  );
  process.exit(1);
}
console.log("lint:wall-clock-assertions OK");
