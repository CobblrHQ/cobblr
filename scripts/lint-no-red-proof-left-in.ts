#!/usr/bin/env tsx
// Shipped source never carries a red proof's switch: a condition forced with && false or || true, if (false), if (true), or a RED PROOF marker.
//
// THE BUG THIS PREVENTS. #4902 (2026-10-08): the switch that held the shared-miss cache off to prove its test red was committed, and the fix shipped disabled
//
// THE RULE. A red proof turns a fix off to watch its test fail, and is put back before
// the commit. In api/src, modules, packages and web/src (tests excluded), a condition
// forced with `&& false)` or `|| true)`, an `if (false)` or `if (true)`, or a line
// marked RED PROOF fails. A guard that must stay forced says why on the same line:
// `// red-proof-ok: <why>`.
//
// THE BOUNDARY. Only TypeScript source that ships: a test may force a branch on
// purpose, and shell scripts' `|| true` is error handling, not a switch (so the
// lint reads .ts/.tsx, never .sh). Nothing on main matched when it was written.
//
// PROVEN RED on #4902's commit: `if (inFlight && false) return inFlight; // RED PROOF`.
//
//   npx tsx scripts/lint-no-red-proof-left-in.ts   (pnpm lint no-red-proof-left-in)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages", "web/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const SWITCH = /&&\s*false\s*\)|\|\|\s*true\s*\)|\bif\s*\(\s*(?:false|true)\s*\)|RED PROOF/;

/** The files that could hold one: git grep picks them, so only those are read. */
function candidates(): string[] {
  try {
    return execFileSync("git", ["grep", "--untracked", "-lE", "&&[[:space:]]*false[[:space:]]*\\)|\\|\\|[[:space:]]*true[[:space:]]*\\)|if[[:space:]]*\\([[:space:]]*(false|true)[[:space:]]*\\)|RED PROOF", "--", ...ROOTS.map((r) => `:(glob)${r}/**/*.ts`), ...ROOTS.map((r) => `:(glob)${r}/**/*.tsx`)], { maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" })
      .split("\n").filter((f) => f && !/\.test\.tsx?$/.test(f));
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 1) return [];
    throw e;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = SWITCH.exec(line);
    if (m && !/\/\/ red-proof-ok: \S/.test(line)) out.push({ file, line: i + 1, what: `a red proof's switch left in (${m[0].trim()})` });
  }
  return out;
}

const violations: Violation[] = [];
for (const file of candidates()) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-red-proof-left-in - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Restore the real condition. A guard that must stay off says why on the line: // red-proof-ok: <why>");
  process.exit(1);
}
console.log(`lint:no-red-proof-left-in OK`);
