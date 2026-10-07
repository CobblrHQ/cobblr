#!/usr/bin/env tsx
// A test file that spawns real processes (child_process, execa) must give its tests a worn() or explicit timeout, or the default 5 s budget breaches under load.
//
// THE BUG THIS PREVENTS. scripts/docker-build-builds-the-tip.test.ts timed out at 5008 ms in a 1,135 s unit run on
// main (2026-10-06, run 37494): it runs the gate step's real bash, jq and two curls as child processes. The unit
// config scales the default budget by the box's load, but ONCE, when the run starts (vitest 2.1.9 fixes a test's
// timeout at collection; a beforeEach cannot change it, probed 2026-10-06), so a run that starts on a quiet box and
// then gets 8 workers of neighbours keeps the quiet 5 s. A test that spawns processes is exactly the kind that
// stretches under load. Main went red for a change that never touched it.
//
// THE RULE. A test file (scripts/, modules/, packages/: the unit config's 5 s default) that imports child_process
// or execa must show a deliberate budget somewhere in the file: `worn(...)` (scripts/lib/load-factor.mjs; the
// repo's convention, see lint:test-timeout-worn), a numeric third argument to it()/test() (`}, 60_000)`), or a
// `// TIMEOUT-UNWORN: <why>` line. Anything else is a finding.
//
// THE RATCHET. 113 test files that spawn processes had no budget when this was written. They are listed in
// scripts/ci/spawning-tests-baseline.json, which can only SHRINK: a listed file that now has a budget (or no longer
// exists or spawns) fails with "remove it from the baseline", and the file carries `maxEntries`, so adding an entry
// means raising a number in a diff a reviewer reads. New spawning tests get no grace.
//
// THE BOUNDARY. api/ is out: its integration config's global testTimeout is 60 s (api/vitest.config.ts), not the
// unit 5 s. A file that spawns only to PROVE something with its own child timeout is not exempt on that account:
// the child's timeout is not the test's.
//
// THE PUBLIC EXPORT ships this lint and the baseline but not most test files: there a listed file that is
// absent is skipped (the check that it still needs its entry runs only on the full tree).
//
// PROVE IT RED: run against the pre-fix docker-build-builds-the-tip.test.ts (it is flagged); the fixed file passes.
//
//   npx tsx scripts/lint-spawning-tests-wear-a-timeout.ts   (pnpm lint spawning-tests-wear-a-timeout)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The unit config's 5 s default applies here. */
const ROOTS = ["scripts", "modules", "packages"];
const BASELINE = "scripts/ci/spawning-tests-baseline.json";

const SPAWNS = /from\s+["'](?:node:)?child_process["']|from\s+["']execa["']|require\(\s*["'](?:node:)?child_process["']\s*\)/;
const BUDGET = /\bworn\(|TIMEOUT-UNWORN:|^\s*\}\s*,\s*\d[\d_]{3,}\s*\)|\b(?:it|test)(?:\.\w+)?\([^\n]*\{\s*timeout:\s*\d/m;

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name === "_tmp" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Does this test file spawn processes without a deliberate budget? */
export function needsABudget(src: string): boolean {
  return SPAWNS.test(src) && !BUDGET.test(src);
}

const baseline: { maxEntries: number; files: string[] } = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { maxEntries: 0, files: [] };
const listed = new Set(baseline.files);
const problems: string[] = [];
const flagged = new Set<string>();

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const f = file.split("\\").join("/");
    if (needsABudget(readFileSync(file, "utf8"))) {
      flagged.add(f);
      if (!listed.has(f)) {
        problems.push(`${f}: spawns processes (child_process/execa) with no worn(...), numeric timeout or // TIMEOUT-UNWORN: reason. The default 5 s budget breaches when the box loads up after the run starts (docker-build-builds-the-tip.test.ts, 5008 ms, 2026-10-06). Pass worn(60_000) as the test's last argument.`);
      }
    }
  }
}
// The public export ships this lint and the baseline but not most test files, so a missing file is only
// an error where the full tree is (the private repo, which has the publish manifest).
const fullTree = existsSync("scripts/publish/manifests/core.json");
for (const f of listed) {
  if (!existsSync(f)) {
    if (fullTree) problems.push(`${BASELINE}: ${f} no longer exists: remove it from the baseline`);
  } else if (!flagged.has(f)) problems.push(`${BASELINE}: ${f} now has a budget (or no longer spawns): remove it from the baseline, the list only shrinks`);
}
if (baseline.files.length > baseline.maxEntries) {
  problems.push(`${BASELINE}: ${baseline.files.length} entries but maxEntries is ${baseline.maxEntries}: the baseline may not grow; give the new test a worn() budget instead`);
}

if (problems.length === 0) {
  console.log(`[lint:spawning-tests-wear-a-timeout] ✓ ${flagged.size} spawning test file(s) without a budget, all grandfathered (${baseline.files.length}/${baseline.maxEntries}); every other spawning test has one`);
  process.exit(0);
}
console.error(`\n[lint:spawning-tests-wear-a-timeout] ✗ ${problems.length} problem(s):\n`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
