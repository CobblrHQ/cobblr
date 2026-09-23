#!/usr/bin/env tsx
// No tracked file carries a merge conflict marker.
//
// THE BUG THIS PREVENTS. docs/README.md and docs/operations/community-servers.md
// both sat on main with unresolved markers, one of them a stash conflict
// ("Updated upstream" / "Stashed changes"), until a cherry-pick tripped over
// them (2026-09-22). Nothing objected: markdown has no compiler, the docs lints
// read structure rather than content, and a conflicted region renders as
// ordinary text on GitHub. One of the two had been re-opening a question the
// same file settles forty lines higher.
//
// THE RULE. A tracked text file may not contain a line beginning with the
// seven-character conflict markers git writes, `<<<<<<<` or `>>>>>>>`. Those
// two are checked and `=======` is not, because a row of equals signs is a
// setext heading underline in markdown and a separator everywhere else, while
// the angle-bracket pair means one thing only. Binary files are skipped. There
// is no opt-out: a file that needs a literal marker at the start of a line
// builds it at runtime, the way this lint's own test does.
//
// PROVED RED on the two files above, restored from main: four violations,
// the open and close of each conflict, and green once they were resolved.
//
//   npx tsx scripts/lint-no-conflict-markers.ts   (pnpm run lint:no-conflict-markers)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** One offending place. `line` is 1-based for a clickable path:line. */
export interface Violation {
  file: string;
  line: number;
  what: string;
}

const OPEN = "<".repeat(7);
const CLOSE = ">".repeat(7);

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith(OPEN)) out.push({ file, line: i + 1, what: `conflict marker: ${line.slice(0, 40)}` });
    else if (line.startsWith(CLOSE)) out.push({ file, line: i + 1, what: `conflict marker: ${line.slice(0, 40)}` });
  }
  return out;
}

/** The files to open. `git grep` narrows in C over tracked files only, which
 *  is exactly the set that can reach main and skips node_modules, dist and
 *  anything a local run left lying about. Its pattern is deliberately the same
 *  two prefixes `check` uses, so the narrowing is a superset of the rule and
 *  cannot hide a violation; `check` remains the one place the rule is written.
 *  Reading all 7,000 tracked files instead took 11 seconds, which is most of
 *  the whole suite's budget for a rule that is almost always a no-op. */
function candidates(): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "-I", "-z", "-e", `^${OPEN}`, "-e", `^${CLOSE}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    // git grep exits 1 when nothing matched, which is the healthy case.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function readText(file: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null; // deleted in the index, or unreadable: not this lint's business
  }
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}

if (process.argv[1]?.endsWith("lint-no-conflict-markers.ts")) {
  const violations: Violation[] = [];
  for (const file of candidates()) {
    const src = readText(file);
    if (src !== null) violations.push(...check(file, src));
  }

  if (violations.length) {
    console.error(`lint:no-conflict-markers - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Resolve the conflict for real: keep what both sides meant, then delete the markers.");
    process.exit(1);
  }
  console.log(`lint:no-conflict-markers OK`);
}
