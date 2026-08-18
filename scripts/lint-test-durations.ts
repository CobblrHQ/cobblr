// Guard: api/tests/file-durations.json must describe tests that actually exist.
//
// WHY THIS IS A LINT: that snapshot drives the longest-first sequencer in
// api/vitest.config.ts. Files it does not name fall back to
// UNKNOWN_FILE_WEIGHT, so a stale entry does not error — it just quietly stops
// scheduling anything, and the suite drifts back toward the shortest-first order
// the sequencer exists to prevent. The symptom is a slower CI job, which nobody
// reads as a bug.
//
// It went stale the first time within hours: splitting platform-pillars.test.ts
// on 2026-08-17 left the snapshot naming a file that no longer existed, and
// nothing would have said so.
//
// ONLY ghost entries are checked, deliberately. An entry naming a file that no
// longer exists is pure rot: it schedules nothing and reads as coverage. The
// mirror case — a file the snapshot has never heard of — is NOT flagged, because
// vitest.config.ts already gives unknown files a pessimistic UNKNOWN_FILE_WEIGHT
// so they schedule early, which is the safe direction; demanding an invented
// number for every new test file would be busywork, and a noisy guardrail is a
// guardrail someone eventually deletes. A file that actually becomes slow enough
// to matter is caught by scripts/check-test-balance.mjs, on real measurements.
//
// The DURATIONS themselves are not checked either — vitest.config.ts says only
// the ORDER matters, and demanding fresh numbers is a chore nobody completes.
//
// Run: npx tsx scripts/lint-test-durations.ts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = join(ROOT, "api", "tests", "file-durations.json");
const TESTS = join(ROOT, "api", "tests");

if (!existsSync(SNAP)) {
  console.log("✓ test-durations lint: no snapshot — nothing to check");
  process.exit(0);
}

const snapshot = JSON.parse(readFileSync(SNAP, "utf8")) as Record<string, number>;
const onDisk = new Set(readdirSync(TESTS).filter((f) => f.endsWith(".test.ts")));

const ghosts = Object.keys(snapshot).filter((f) => !onDisk.has(f));

if (ghosts.length === 0) {
  console.log(`✓ test-durations lint: all ${Object.keys(snapshot).length} snapshot entries name a real test file`);
  process.exit(0);
}

console.error(
  `✗ lint-test-durations: api/tests/file-durations.json names ${ghosts.length} ` +
    `file(s) that no longer exist:\n`,
);
for (const g of ghosts) console.error(`    - ${g}`);
console.error(
  "\n  Remove them, and add the replacements if it was a split or a rename. The\n" +
    "  sequencer reads this snapshot to run the longest files first; an entry that\n" +
    "  matches nothing schedules nothing while still looking like it does.\n",
);
process.exit(1);
