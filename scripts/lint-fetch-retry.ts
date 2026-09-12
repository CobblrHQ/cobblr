#!/usr/bin/env tsx
// A script under scripts/ never runs a bare git fetch: it fetches through fetch_retry from scripts/lib/fetch-retry.sh, so a ref lock lost to another worktree's fetch is tried again instead of killing the script after its real work.
//
// THE BUG THIS PREVENTS. On 2026-09-13 merge-pr.sh died on 'cannot lock ref refs/remotes/origin/main' one line after '#2818 merged.': two agents' fetches on the shared .git landed together, so the worktree stayed on its spent branch, main went unwatched and the exit code read 1 for a merge that had gone through (#2822 fixed the two merge scripts; every other fetch under scripts/ can die the same way).
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-fetch-retry.ts   (pnpm run lint:fetch-retry)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
// LINT_FETCH_RETRY_ROOT is the test seam: a fixture tree instead of scripts/.
const ROOTS = [process.env.LINT_FETCH_RETRY_ROOT ?? "scripts"];

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
    // Shell scripts and the shell libs they source. The .mjs/.ts scripts shell
    // out through execFileSync; those are judged by the second pattern.
    else if (/\.(sh|mjs|ts)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && name !== "fetch-retry.sh") yield p;
  }
}

/** A shell line that runs git fetch itself: `git fetch`, `git -C x fetch`,
 *  `"${g[@]}" fetch` (an array holding `git -C dir`). Not a comment, not an
 *  echoed recipe, not a string a script prints for a human to run. */
const SHELL_FETCH = /(^\s*|[;&|()]\s*|\$\(\s*|\b(then|do|else)\s+)(git(\s+-C\s+("[^"]*"|'[^']*'|\S+))?|"\$\{[a-zA-Z_]+\[@\]\}")\s+fetch\b/;
/** A node script that spawns git fetch. */
const NODE_FETCH = /\b(execFileSync|execFile|spawnSync|spawn|execSync)\(\s*["']git["']\s*,\s*\[\s*["']fetch["']/;
/** The opt-out, on the line or the one above it. */
const ALLOW = /# bare-fetch: \S/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const shell = file.endsWith(".sh");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/^\s+/, "");
    if (code.startsWith("#") || code.startsWith("//")) continue;
    // What a script SAYS to a human is not what it runs.
    if (/^\s*(echo|printf)\b/.test(code)) continue;
    const hit = shell ? SHELL_FETCH.test(line) : NODE_FETCH.test(line);
    if (!hit) continue;
    if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: `bare git fetch: ${code.slice(0, 90)}` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:fetch-retry - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("source scripts/lib/fetch-retry.sh and call fetch_retry <args> (in a lib: (cd \"$repo\" && fetch_retry ...)); a line that genuinely must fetch bare says why with '# bare-fetch: <reason>'");
  process.exit(1);
}
console.log(`lint:fetch-retry OK`);
