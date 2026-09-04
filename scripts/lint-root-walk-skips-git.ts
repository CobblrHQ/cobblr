// A lint that walks the repo root must not walk into `.git`.
//
// 2026-09-04, on a PR that had touched nothing near it:
//
//   ✗ lint:notification-deep-links — exit 1
//     Error: ENOENT: no such file or directory, stat
//       '/workspace/CobblrHQ/core/.git/refs/remotes/origin/wt/nav-child-drag.lock'
//
// `.git` is the one directory in the tree that CHANGES WHILE YOU READ IT. A
// concurrent fetch writes `refs/remotes/origin/<branch>.lock` and removes it
// milliseconds later, so a name returned by readdirSync is already gone by the
// statSync on the next line. On a shared runner that is not rare, it is
// whenever two jobs overlap - and the lint does not report a finding, it
// CRASHES, which fails somebody's unrelated PR and sends them reading a diff
// that has nothing to do with it.
//
// Nothing a source lint wants is in `.git`. Four lints walked from the root;
// three of them walked straight into it.
//
// THE RULE, for a walk seeded at the repo root:
//   1. skip `.git` by name, and
//   2. wrap `statSync` in try/catch - an entry that vanishes mid-walk is
//      skipped, never thrown on.
//
// Both, because either alone still loses: skipping `.git` leaves every other
// transient file (an editor swap, a build artefact being replaced) able to kill
// the run, and guarding the stat alone means the walk still descends into
// thousands of refs to learn nothing.
//
// Best of all is not to hand-roll the walk: `sourceFiles()` from
// ./lib/glob-exclude.mjs is the shared, already-correct way to enumerate
// authored files.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "scripts";

/** Seeded at the repo root, rather than at a known source directory. */
const ROOT_SEEDED = /walk\(\s*"\."\s*\)|walk\(\s*ROOT\s*\)|readdirSync\(\s*ROOT\s*\)|readdirSync\(\s*"\."\s*\)/;

const offenders: string[] = [];

for (const file of readdirSync(DIR)) {
  if (!file.startsWith("lint-") || !/\.(ts|mjs)$/.test(file)) continue;
  let src: string;
  try {
    src = readFileSync(join(DIR, file), "utf8");
  } catch {
    continue;
  }
  if (!src.includes("readdirSync")) continue;
  // The shared helper is already correct; a lint using it is not hand-rolling.
  if (src.includes("glob-exclude")) continue;
  if (!ROOT_SEEDED.test(src)) continue;

  const skipsGit = /["']\.git["']/.test(src);
  // A statSync inside a try, or no statSync at all (withFileTypes does not throw).
  const guardsStat = !src.includes("statSync") || /try\s*\{[\s\S]{0,200}?statSync/.test(src);
  const missing = [!skipsGit && "does not skip .git", !guardsStat && "statSync is not guarded"]
    .filter(Boolean)
    .join("; ");
  if (missing) offenders.push(`${DIR}/${file}  ${missing}`);
}

if (offenders.length > 0) {
  console.error(
    "[lint:root-walk-skips-git] ✗ a root walk can be killed by a concurrent git operation:\n" +
      offenders.map((o) => `  ${o}`).join("\n") +
      "\n\n  `.git` changes while you read it - a fetch writes <branch>.lock and removes\n" +
      "  it milliseconds later, so readdirSync returns a name statSync then throws on.\n" +
      "  The lint does not fail, it CRASHES, and it fails an unrelated PR.\n" +
      "  Skip `.git` by name AND wrap statSync in try/catch. Better still, use\n" +
      "  sourceFiles() from ./lib/glob-exclude.mjs instead of walking by hand.",
  );
  process.exit(1);
}

console.log("[lint:root-walk-skips-git] ✓ every root walk skips .git and tolerates a vanished entry");
