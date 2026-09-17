#!/usr/bin/env tsx
// scripts/lint-durations.json names only lints that exist and covers nearly
// all of them, so the per-lint budget judges against a real quiet time rather
// than the snapshot median.
//
// THE BUG THIS PREVENTS. The lint budget (scripts/lib/lint-budget.mjs) judges
// every lint against its own recorded quiet time. A lint the snapshot does not
// know is judged at the snapshot's median (~0.5s), which is right for a new
// cheap lint and wrong for a legitimately heavier one that simply was never
// recorded: it fails on every quiet run until someone records it. And an entry
// for a lint that no longer exists is rot that reads as coverage, the same
// failure lint:test-durations guards for api/tests/file-durations.json.
//
// THE RULE. Every name in the snapshot's `ms` map is a lint:* script that
// package.json still runs, and at most MAX_UNKNOWN lints that run are missing
// from it. Record the missing ones with
// `node scripts/lint-durations-record-missing.mjs` (their CI-measured time
// from the newest green typecheck log in the sink; no idle machine needed),
// commit the file. MAX_UNKNOWN is a pressure valve, not a quota: it filled on
// five other people's merges in one week and blocked the sixth builder
// mid-feature (2026-09-17), which is why recording is one command now and
// part of writing a lint.
//
// The DURATIONS themselves are not checked: the runner measures those on every
// run, and a baseline that drifted is caught the moment a quiet run compares
// against it.
//
//   npx tsx scripts/lint-lint-durations.ts   (pnpm run lint:lint-durations)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverLints } from "./run-lints.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, "scripts", "lint-durations.json");
const MAX_UNKNOWN = 5;

if (!existsSync(SNAP)) {
  console.error("lint:lint-durations - scripts/lint-durations.json is missing; the budget has no baseline. Record one: node scripts/run-lints.mjs --record");
  process.exit(1);
}
const ms: Record<string, number> = JSON.parse(readFileSync(SNAP, "utf8")).ms ?? {};
const { run } = discoverLints() as { run: string[] };
const live = new Set(run);
const ghosts = Object.keys(ms).filter((n) => !live.has(n));
const unknown = run.filter((n) => !(n in ms));
const problems: string[] = [];
if (ghosts.length) problems.push(`${ghosts.length} entr${ghosts.length === 1 ? "y names" : "ies name"} a lint that no longer runs: ${ghosts.join(", ")}`);
if (unknown.length > MAX_UNKNOWN) problems.push(`${unknown.length} lints that run are not in the snapshot (limit ${MAX_UNKNOWN}): ${unknown.join(", ")}`);
if (problems.length) {
  console.error(`lint:lint-durations - the lint budget's baseline is stale:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`  Record the missing ones from CI's own clock: node scripts/lint-durations-record-missing.mjs`);
  console.error(`  (newest green typecheck log from the sink; then commit scripts/lint-durations.json). A full refresh is`);
  console.error(`  node scripts/run-lints.mjs --record on idle CI-class hardware.`);
  process.exit(1);
}
console.log(`lint:lint-durations OK (${Object.keys(ms).length} baselines, ${unknown.length} lint(s) not yet recorded)`);
