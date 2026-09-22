#!/usr/bin/env tsx
// Every lint that runs has its recorded quiet time, in its own file, and
// nothing else lives where those times are read.
//
// THE BUG THIS PREVENTS. The lint budget (scripts/lib/lint-budget.mjs) judges
// every lint against its own recorded quiet time. A lint the baseline does not
// know is judged at the median (~0.5s), which is right for a new cheap lint
// and wrong for a legitimately heavier one that simply was never recorded: it
// fails on every quiet run until someone records it. An entry for a lint that
// no longer exists is rot that reads as coverage, the same failure
// lint:test-durations guards for api/tests/file-durations.json.
//
// The times used to be one keyed map every branch appended to, so two
// branches adding two lints conflicted and either resolution dropped one
// (2026-09-22). They live one per file now (scripts/lib/lint-durations.mjs),
// which makes that drop impossible rather than detectable, so there is no
// tolerance here: not one running lint may be missing.
//
// THE RULE.
//   - Every lint:* script package.json runs has scripts/lint-durations/<name>.json.
//   - Every file names a lint that still runs.
//   - Every file is exactly one lint's time under its own filename: the keys
//     lint/ms/recorded/source and nothing else, `lint` equal to the filename,
//     `ms` a positive number. The old map grew two lint entries at its top
//     level beside `ms`, where nothing read them; a second lint's name inside
//     another lint's file would be the same thing again.
//   - The old map, scripts/lint-durations.json, does not come back.
//
// Record a missing one from CI's own clock with
// `node scripts/lint-durations-record-missing.mjs`; scripts/new-lint.sh
// records a new lint itself. The DURATIONS are not judged here: the runner
// measures them on every run, and a drifted baseline is caught the moment a
// quiet run compares against it.
//
//   npx tsx scripts/lint-lint-durations.ts   (pnpm run lint:lint-durations)
import { discoverLints } from "./run-lints.mjs";
import { auditDurations, readQuietMs } from "./lib/lint-durations.mjs";

const ms: Record<string, number> = readQuietMs();
const { run } = discoverLints() as { run: string[] };
const live = new Set(run);
const ghosts = Object.keys(ms).filter((n) => !live.has(n));
const unknown = run.filter((n) => !(n in ms));

const problems: string[] = (auditDurations() as string[]).map((p) => `malformed: ${p}`);
if (ghosts.length) problems.push(`${ghosts.length} file${ghosts.length === 1 ? " names" : "s name"} a lint that no longer runs: ${ghosts.join(", ")} (delete the file)`);
if (unknown.length) problems.push(`${unknown.length} lint${unknown.length === 1 ? " that runs has" : "s that run have"} no recorded quiet time: ${unknown.join(", ")}`);

if (problems.length) {
  console.error("lint:lint-durations - the lint budget's baseline is incomplete or malformed:");
  for (const p of problems) console.error(`  ${p}`);
  console.error("  Record from CI's own clock: node scripts/lint-durations-record-missing.mjs  (newest green typecheck");
  console.error("  log from the sink; then commit scripts/lint-durations/). A full refresh is node scripts/run-lints.mjs");
  console.error("  --record on idle CI-class hardware. scripts/new-lint.sh records a new lint itself.");
  process.exit(1);
}
console.log(`lint:lint-durations OK (${Object.keys(ms).length} baselines, one file per lint, none missing)`);
