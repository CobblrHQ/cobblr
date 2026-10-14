#!/usr/bin/env tsx
// A script that reads a list of pull requests reads every page of it, or says why one page is the point
//
// THE BUG THIS PREVENTS. the pre-push branch-live check read the fifty most recent PRs and told a session its open PR did not exist, and let a push to a spent branch through; worktree triage asked for 100 and Forgejo gave 50 (2026-09-30)
//
// THE RULE. A line in a script that asks Forgejo for a list of pull requests
// (`pulls?state=`) either pages it (a page number that moves, `page=${n},
// `page=$n` or a Python f-string's `page={n}`, or a `paged(` helper) or carries `ONE-PAGE: <why>` on the line or the
// two above it. Forgejo answers at most 50 a page whatever `limit` asks, and
// the fleet keeps more than that open, so one read is a sample, not the list.
// Asking for one PR by its head branch (`pulls/main/<branch>`) is not a list.
//
// THE BOUNDARY. Tests are skipped: a test's fake Forgejo serves the list it is
// asked for. A deliberate recent window (worktree triage's recently merged,
// merged-prs-on-main's last N) is legitimate and says so.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-pr-lists-are-paged.ts   (pnpm lint pr-lists-are-paged)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts"];

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
    else if (/\.(ts|mjs|js|cjs|sh)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Paged: a page number that moves (page=${n} / page=$n), or a paging helper.
    // A Python f-string's `page={page}` moves the same way (merged-prs-on-main.sh pages in Python).
    if (!/pulls\?state=/.test(line) || /page=\$/.test(line) || /page=\{\w+\}/.test(line) || /\bpaged\(/.test(line)) continue;
    const near = [lines[i - 2] ?? "", lines[i - 1] ?? "", line].join("\n");
    if (/ONE-PAGE: \S/.test(near)) continue;
    out.push({ file, line: i + 1, what: "one page of pull requests read as the whole list (Forgejo answers 50 a page)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:pr-lists-are-paged - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("loop page=1.. until a page comes back short, or ask for one PR by head (GET /pulls/main/<branch>); a deliberate window says // ONE-PAGE: <why> (or # ONE-PAGE: in shell) on the line above");
  process.exit(1);
}
console.log(`lint:pr-lists-are-paged OK`);
