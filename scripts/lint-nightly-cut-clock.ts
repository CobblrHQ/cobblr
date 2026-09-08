#!/usr/bin/env tsx
// The nightly cut's clock is stated ONCE, in the deploy box's own zone.
//
// The cut is a cron on the deploy box, `0 4 * * *` in America/New_York. It is
// not 04:00 UTC, and it never was: the published images are created at 08:03
// UTC in summer. On 2026-09-08 a support-bot boundary, the deploy-state footer,
// two skills and a design doc all said "04:00 UTC" - each written by someone
// who had read one of the others - so for four hours every night the bot named
// a self-hoster's tag one day late.
//
// The class: a clock about the cut, written down in UTC by hand, drifting from
// the cron that actually runs. Two rules kill it:
//
//   1. scripts/lib/deploy-state.sh carries the zone and hour (NIGHTLY_CUT_ZONE,
//      NIGHTLY_CUT_HOUR) and prints the next tag from them. Anything that wants
//      the date calls that; it does not recompute.
//   2. No line under scripts/, .claude/skills/, CLAUDE.md or the release docs may
//      state the nightly cut as a UTC clock. Say "04:00 on the deploy box (US
//      Eastern)" or, better, print the tag from deploy_state_brief.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_OF_TRUTH = "scripts/lib/deploy-state.sh";
const SCAN_DIRS = ["scripts", ".claude/skills"];
const SCAN_FILES = [
  "CLAUDE.md",
  "docs/design-decisions/release-topology.md",
  "docs/design-decisions/release-channels.md",
  "docs/operations/CI_DEPLOY.md",
];
const UTC_CLOCK = /\b0?[0-9]:00\s*UTC\b/i;
// "cut" or "nightly release": other UTC crons (the tour recording on CI) are not this clock.
const ABOUT_THE_CUT = /\bcut\b|nightly release/i;

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|sh|md)$/.test(name)) out.push(p);
  }
}

const files: string[] = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
for (const f of SCAN_FILES) files.push(join(ROOT, f));

const bad: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel === "scripts/lint-nightly-cut-clock.ts") continue;
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (UTC_CLOCK.test(line) && ABOUT_THE_CUT.test(line)) bad.push(`  ${rel}:${i + 1}: ${line.trim()}`);
  });
}

const truth = readFileSync(join(ROOT, SOURCE_OF_TRUTH), "utf8");
for (const needle of ['NIGHTLY_CUT_ZONE="America/New_York"', "NIGHTLY_CUT_HOUR=4", "next_nightly_cut()"]) {
  if (!truth.includes(needle)) bad.push(`  ${SOURCE_OF_TRUTH}: no longer carries ${needle}`);
}

if (bad.length) {
  console.error("lint:nightly-cut-clock - the nightly cut stated as a UTC clock, or the source of truth gone:\n");
  for (const b of bad) console.error(b);
  console.error(
    "\nThe cut is 04:00 on the deploy box (America/New_York), which is 08:00 UTC in\n" +
      "summer and 09:00 in winter. Write it in the box's zone, or print the tag with\n" +
      "next_nightly_cut / deploy_state_brief from scripts/lib/deploy-state.sh.\n",
  );
  process.exit(1);
}
console.log(`lint:nightly-cut-clock - ${files.length} files state the cut in the box's zone; deploy-state.sh is the one clock.`);
