#!/usr/bin/env tsx
// The coupling census must be dispatched from an EXIT trap installed before the
// first exit that follows release/nightly being resolved - so a new early-exit
// path cannot silently skip a reading.
//
// THE BUG THIS PREVENTS. 2026-09-06 has no reading at all. The dispatch was a
// single curl at the bottom of the happy path, and a quiet day exits early at
// "nothing new to ship" hundreds of lines before it, so the census simply never
// ran. That is the one hole the design was supposed to not have: a history that
// skips its quietest nights cannot tell "steady for a week" from "the job died a
// week ago", which is the entire reason a row is written even when nothing moved.
// The hole was invisible because every OTHER night wrote a row.
//
// THE RULE, in two halves.
//
//   1. `trap dispatch_census EXIT` must be installed before any `exit` that comes
//      AFTER the release refs are fetched. Exits before that point - a bad flag,
//      no green commit, no token - are refusals that happen before there is a
//      release to measure, and a reading there would name nothing. The fetch of
//      `refs/heads/release/*` is the anchor because it is the moment the script
//      knows what "released" currently means.
//
//   2. The dispatch itself may appear ONLY inside `dispatch_census`. A second
//      call site is how this regressed the first time: the reachable-from-here
//      reasoning is what rots when somebody adds an exit above it. One call
//      site, reached by a trap, cannot.
//
// There is no opt-out annotation on purpose. An exit that genuinely must not
// record a reading (a dry run) belongs behind a guard INSIDE dispatch_census -
// where the reason is written down once - not behind a new bare exit.
//
//   npx tsx scripts/lint-census-on-every-exit.ts   (pnpm run lint:census-on-every-exit)
import { readFileSync, existsSync } from "node:fs";

const FILE = "scripts/release-daily.sh";
/** The moment the script knows what is currently released. */
const ANCHOR = "refs/heads/release/*:refs/remotes/origin/release/*";
const TRAP = "trap dispatch_census EXIT";
const FN = "dispatch_census() {";
const DISPATCH = "coupling-census.yml/dispatches";

interface Violation {
  line: number;
  what: string;
}

function check(src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));

  const anchor = idx(ANCHOR);
  const trap = idx(TRAP);
  if (anchor < 0) {
    out.push({ line: 1, what: `the release-refs fetch ("${ANCHOR}") is gone, so this lint can no longer tell which exits matter. Re-anchor it.` });
    return out;
  }
  if (trap < 0) {
    out.push({ line: 1, what: `no \`${TRAP}\`. Without it the census only runs on whichever path happens to reach the dispatch, which is how 2026-09-06 lost its reading.` });
    return out;
  }

  // 1. nothing may exit between knowing the release and arming the trap.
  for (let i = anchor + 1; i < trap; i++) {
    const l = lines[i] ?? "";
    if (/(^|;|\{|\|\|)\s*exit\b/.test(l)) {
      out.push({ line: i + 1, what: `exits after release/nightly is known but before \`${TRAP}\` (line ${trap + 1}), so this path records no reading. Move the trap above it.` });
    }
  }

  // 2. one call site, and it is the trap's function.
  const fnStart = idx(FN);
  let fnEnd = -1;
  if (fnStart >= 0) for (let i = fnStart + 1; i < lines.length; i++) if (lines[i] === "}") { fnEnd = i; break; }
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? "").includes(DISPATCH)) continue;
    const inFn = fnStart >= 0 && fnEnd > fnStart && i > fnStart && i < fnEnd;
    if (!inFn) {
      out.push({ line: i + 1, what: `dispatches the census outside \`dispatch_census\`. A second call site is reachable only from the paths that happen to pass it - put it in the function the trap calls.` });
    }
  }
  return out;
}

if (!existsSync(FILE)) {
  console.log(`lint:census-on-every-exit OK (${FILE} not present)`);
  process.exit(0);
}
const violations = check(readFileSync(FILE, "utf8"));
if (violations.length) {
  console.error(`lint:census-on-every-exit - ${violations.length} violation(s) in ${FILE}:`);
  for (const v of violations) console.error(`  ${FILE}:${v.line}  ${v.what}`);
  console.error("The census is a measurement: it must fire on EVERY exit that follows a resolved release, including the quiet ones.");
  process.exit(1);
}
console.log("lint:census-on-every-exit OK");
