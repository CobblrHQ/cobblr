#!/usr/bin/env tsx
// A script that lists the open pull requests reads them through scripts/lib/open-pulls.mjs, the box's shared copy, never by paging the forge itself
//
// THE BUG THIS PREVENTS. 2026-11-18: the forge served ~710 open-pull-request list calls an hour from the fleet's one machine and read 3.1 GB in five minutes doing it (#9573)
//
// THE RULE. A line under scripts/ that asks the forge for the list of open pull requests (the open state of the pulls list, in any
// language) fails, unless it is in scripts/lib/open-pulls.mjs (the one reader) or its file is in NOT_YET below with the
// reason it still reads for itself. Tests are skipped: a test's fake forge serves what it is asked. A closed or merged
// list (`state=closed`) is not this rule's: nothing polls it every minute.
//
// THE BOUNDARY. NOT_YET is the work left, not a baseline that grows: an entry whose file no longer asks for the list
// fails too ("move it off NOT_YET"), so the list only shrinks, and a new reader cannot join it without a reason here.
// The first readers moved (#9573) were the busiest: the merge queue's bash and python halves and its admission pass,
// together about 570 of the ~710 calls an hour.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-open-pulls-through-the-cache.ts   (pnpm lint open-pulls-through-the-cache)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts"];
const READER = "scripts/lib/open-pulls.mjs";
const LIST = /pulls\?state=open/;

/** The files that still page the forge themselves, each with why: the work left (#9573). It only shrinks. */
const NOT_YET: Record<string, string> = {
  "scripts/ci-head-runs.mjs": "a person's one-off report, run by hand",
  "scripts/ci-status-floor.mjs": "the hourly status floor; moves next",
  "scripts/lib/branch-pr.sh": "one branch's own pull request, asked as it is pushed: it must see a pull request opened seconds ago",
  "scripts/lib/bridge-embed-drift.mjs": "the edge-bridge drift check, hourly",
  "scripts/lib/open-pr-ordinals.mjs": "migration ordinals at push time: must see a pull request opened seconds ago",
  "scripts/lib/rig-ran.mjs": "the rig-ran stamp, once per walk",
  "scripts/lib/supersede-embeds.mjs": "the embed superseder, on a new embed",
  "scripts/lint-branch-live.mjs": "the pre-push branch check: must see a pull request merged seconds ago",
  "scripts/merge-pr.sh": "a merge, which must see the forge's latest",
  "scripts/org-landed-open-prs.mjs": "a person's one-off report, run by hand",
  "scripts/unready-prs-check.mjs": "the hourly unready check; moves next",
  "scripts/worktree-triage.sh": "a person's worktree triage, run by hand",
};

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx|mjs|js|sh|py)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file === READER || file === "scripts/lint-open-pulls-through-the-cache.ts") return out;
  const lines = src.split("\n");
  const asks = lines.flatMap((l, i) => (LIST.test(l) ? [i + 1] : []));
  if (NOT_YET[file]) {
    if (!asks.length) out.push({ file, line: 1, what: "no longer lists the open pull requests itself: move it off NOT_YET in this lint" });
    return out;
  }
  for (const line of asks) out.push({ file, line, what: "lists the open pull requests from the forge itself: read them through scripts/lib/open-pulls.mjs" });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
// An entry whose file is gone is work no longer left.
for (const f of Object.keys(NOT_YET)) {
  try {
    statSync(f);
  } catch {
    violations.push({ file: f, line: 1, what: "is gone: take it off NOT_YET in this lint" });
  }
}

if (violations.length) {
  console.error(`lint:open-pulls-through-the-cache - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use openPulls({ api }) from scripts/lib/open-pulls.mjs, or node scripts/lib/open-pulls.mjs from a shell");
  process.exit(1);
}
console.log(`lint:open-pulls-through-the-cache OK`);
