#!/usr/bin/env tsx
// A script run on a workstation writes its scratch files to a per-run mktemp path, never a fixed /tmp name, because several sessions run the same script at once on one machine and a fixed name hands one run another's answer.
//
// THE BUG THIS PREVENTS. merge-pr.sh wrote the merge response to /tmp/merge-pr.out: concurrent merges shared it, and on a fresh box its absence stopped the script under set -e before the issue heard the merge had failed (#3459, 2026-09-22).
//
// THE RULE. In a shell script under scripts/, a line that WRITES to a fixed
// /tmp/<name> fails: `-o /tmp/x`, `> /tmp/x`, `>> /tmp/x`, `tee [-a] /tmp/x`,
// or an assignment `X=/tmp/x` (the name is then written through $X). A read
// of a default (`${VAR:-/tmp/x}`) passes, and so does anything under
// ${TMPDIR:-/tmp} or from mktemp. Two ways out, each with a reason:
//   - `# FIXED-TMP: <why>` on the line, for one name that is safe to share
//     (a per-version release-notes path the operator opens by name);
//   - `# FIXED-TMP-FILE: <why>` anywhere in the file, for a script that only
//     ever runs inside a CI job, where every job has its own /tmp.
// A workstation script is the default because nothing marks one: the hosts
// that share a /tmp are the ones this repo runs several sessions on.
//
// Proven red on merge-pr.sh before its fix (2 violations, the two
// `curl -o /tmp/merge-pr.out` calls).
//
//   npx tsx scripts/lint-workstation-tmp-per-run.ts   (pnpm run lint:workstation-tmp-per-run)
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
    else if (/\.sh$/.test(name) || dir.endsWith("git-hooks")) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (/^#\s*FIXED-TMP-FILE:\s*\S/m.test(src)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*#/.test(line) || /#\s*FIXED-TMP:\s*\S/.test(line)) continue;
    const write = /(?:-o|>>?|\btee(?:\s+-a)?)\s*"?\/tmp\/[A-Za-z][^\s"';)]*/.exec(line);
    const assign = /^\s*(?:local\s+|export\s+)?[A-Za-z_][A-Za-z0-9_]*="?\/tmp\/[A-Za-z][^\s"';)]*/.exec(line);
    if (write || assign) {
      out.push({ file, line: i + 1, what: `fixed /tmp name: ${(write ?? assign)![0].trim()}` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workstation-tmp-per-run - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("MERGE_OUT=\"$(mktemp \"${TMPDIR:-/tmp}/<name>.XXXXXX\")\" and remove it in the EXIT trap");
  process.exit(1);
}
console.log(`lint:workstation-tmp-per-run OK`);
