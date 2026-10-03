#!/usr/bin/env tsx
// Nothing an agent reads may say cobblr.me waits for a manual promote: the 04:00 daily release promotes it to the nightly's build, and only an off-cycle promote is the owner's.
//
// THE BUG THIS PREVENTS. 2026-10-03: the coordinator told the owner cobblr.me was pinned and sharing waited on a promote; deploy-gap, the feedback skill, the platform spec and the classifier context all said so, but cobblr.me was on the same build as the nightly.
//
// THE RULE. A line in agent-read text (docs, scripts, skills, CLAUDE.md) fails
// when it says cobblr.me is "pinned", or that a hosted user gets a fix only when
// the owner promotes ("when the OWNER runs the release", "when <name> promotes",
// "hosted ... <name>-gated"). The truth lives in scripts/release-daily.sh: the 04:00
// run promotes cobblr.me to the nightly's build; only an off-cycle promote is
// the owner's. A line that must say it anyway (a quote, a history note) opts out
// with `cadence-ok: <reason>` on the same line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. deploy-gap.sh talks about the
// "pinned WEB image" and the "pinned prod container": a box pins an exact image
// by sha between releases, which is true. So "pinned" only fails next to
// cobblr.me itself, within the same short phrase.
//
// PROVE IT RED: run against origin/main before this change; it named the
// deploy-gap message, the feedback skill and the platform spec.
//
//   npx tsx scripts/lint-release-cadence-claims.ts   (pnpm lint release-cadence-claims)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["docs", "scripts", ".claude", "CLAUDE.md"];

/** Each stale claim, and what it wrongly tells the reader. */
const CLAIMS: [RegExp, string][] = [
  [/cobblr\.me\W{0,3}(?:\w+\W{1,3}){0,3}pinned\b|\bpinned\W{1,3}(?:\w+\W{1,3}){0,2}cobblr\.me/i, "calls cobblr.me pinned; the daily release promotes it"],
  [/when the owner runs the release/i, "says a hosted user waits for the owner; the daily release ships it"],
  [/a hosted user[^.\n]{0,20}when \w+ \**promotes/i, "says a hosted user waits for a person; the daily release ships it"],
  [/hosted\b[^.\n]{0,40}\b[A-Z][a-z]+-gated/, "calls the hosted deploy person-gated; only an off-cycle promote is"],
];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  if (statSync(dir, { throwIfNoEntry: false })?.isFile()) {
    yield dir;
    return;
  }
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
    else if (/\.(md|sh|ts|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/lint-release-cadence-claims/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/cadence-ok: \S/.test(line)) continue;
    for (const [re, what] of CLAIMS) if (re.test(line)) out.push({ file, line: i + 1, what });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:release-cadence-claims - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Say: cobblr.me gets the build at the 04:00 daily release (release-daily.sh); only an off-cycle promote needs the owner.");
  process.exit(1);
}
console.log(`lint:release-cadence-claims OK`);
