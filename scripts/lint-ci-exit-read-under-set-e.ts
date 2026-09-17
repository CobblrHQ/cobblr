#!/usr/bin/env tsx
// A workflow step that reads a command's exit code after the fact guards the
// command with `||` first, because the runner's `bash -e` ends the step
// before the read.
//
// THE BUG THIS PREVENTS (#3150, 2026-09-17). The CI test job's retry step ran
//
//   node ../scripts/ci-starvation-verdict.mjs judge samples | tee out
//   rc=${PIPESTATUS[0]}
//   if [ "$rc" != 3 ]; then ...; exit 0; fi
//
// Forgejo runs every `run:` block as `bash -e -o pipefail`. The judge exits 3
// to say STARVED, pipefail makes the pipeline exit 3, `-e` ends the step on
// that line, and the read on the next line never happens. So the one exit
// code the step existed for killed it: runs 22733, 22738 and 22783 were each
// judged starved, each retry step died in 0 seconds, the verdict step was
// skipped, and main posted red for a neighbour's load. The path had never
// run on the case it was built for. The same shape sat in nightly-tour.yml
// (`echo "exit=${PIPESTATUS[0]}"` after a piped tour).
//
// THE RULE. In every `.forgejo/workflows/*.yml` `run:` block, and in every
// shell script under scripts/ that puts itself under `set -e` (a step that
// invokes such a script has the identical failure, one file away), a line
// that reads `$?` or `${PIPESTATUS[...]}` must be preceded by a command line
// that cannot end the shell: one carrying `||` (the guard), or one that is a
// condition (`if`, `while`, `until`, `!`), or the shell must have said
// `set +e` earlier. A read under a bare `-e` is a violation whether or not it
// looks reachable, because a zero status is the only one that ever reaches
// it. No opt-out annotation: write `cmd || rc=$?`.
//
// WHAT IT CANNOT SEE: a script without `set -e` (reads there are fine: the
// shell continues), a `run:` block that names a different shell, and a
// helper sourced into an `-e` shell from outside scripts/. The workflow half
// is the one that bit.
//
// PROVEN RED 2026-09-17 against nightly-tour.yml's tour step and ci.yml's
// retry step as they were on main; the scripts/ half found nothing that day
// (every `$?` read in a `set -e` script there was already guarded).
//
//   npx tsx scripts/lint-ci-exit-read-under-set-e.ts   (pnpm run lint:ci-exit-read-under-set-e)
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const READ = /\$\?|\$\{PIPESTATUS\[/;
// A previous line that cannot end the shell: a `||` list, a condition, or the
// opener of a block whose condition just ran (`…; then`, `…; do`, `else`).
const GUARDED = /\|\||^\s*(if|while|until|elif|else|then|do)\b|^\s*!\s|;\s*(then|do)\s*$/;
// The one idiom that reads $? first thing on purpose: a function opened for
// a trap (`f() { local rc=$?`), which reads the status the trap fired on.
const TRAP_IDIOM = /^\s*local\s+\w+=\$\?\s*$/;
const SET_PLUS_E = /^\s*set\s+\+e\b/;

/** A shell script that runs under -e: `set -e`, `set -euo pipefail`, a `#!/…bash -e` line. */
function underSetE(src: string): boolean {
  return /^\s*set\s+-[a-zA-Z]*e[a-zA-Z]*\b/m.test(src) || /^#!.*\bbash\b.*\s-[a-zA-Z]*e/.test(src.split("\n")[0] ?? "");
}

/** The `run: |` blocks of a workflow, as [startLine, lines[]]. */
function runBlocks(src: string): Array<{ start: number; lines: string[] }> {
  const out: Array<{ start: number; lines: string[] }> = [];
  const all = src.split("\n");
  for (let i = 0; i < all.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*\|/.exec(all[i] ?? "");
    if (!m) continue;
    const keyIndent = (all[i] ?? "").search(/\S/);
    const lines: string[] = [];
    let j = i + 1;
    for (; j < all.length; j++) {
      const l = all[j] ?? "";
      if (l.trim() === "") {
        lines.push(l);
        continue;
      }
      if (l.search(/\S/) <= keyIndent) break;
      lines.push(l);
    }
    out.push({ start: i + 2, lines });
    i = j - 1;
  }
  return out;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const blocks = file.endsWith(".sh") ? (underSetE(src) ? [{ start: 1, lines: src.split("\n") }] : []) : runBlocks(src);
  for (const b of blocks) {
    let plusE = false;
    let prevCmd = "";
    for (let k = 0; k < b.lines.length; k++) {
      const l = b.lines[k] ?? "";
      const t = l.trim();
      if (t === "" || t.startsWith("#")) continue;
      if (SET_PLUS_E.test(t)) plusE = true;
      if (READ.test(t) && !plusE && !(TRAP_IDIOM.test(t) && /\{\s*$/.test(prevCmd))) {
        // The command whose status is read: the one before the read on the
        // same line (`has_image "$x"; ic=$?`), else the previous line.
        const readAt = t.search(READ);
        const before = t.slice(0, readAt);
        const semi = before.lastIndexOf(";");
        const sameLine = semi >= 0 ? before.slice(0, semi).trim() : "";
        const judged = sameLine || prevCmd;
        // `cmd || rc=$?` is the fix, not the bug.
        const fixShape = /\|\|\s*\w+=\$\?/.test(t);
        if (!fixShape && !GUARDED.test(judged)) {
          out.push({ file, line: b.start + k, what: `reads ${/PIPESTATUS/.test(t) ? "PIPESTATUS" : "$?"} after \`${judged.trim().slice(0, 60)}\`, which ends the shell under -e when it fails; write \`cmd || rc=$?\`` });
        }
      }
      prevCmd = t;
    }
  }
  return out;
}

if (process.argv[1] && /lint-ci-exit-read-under-set-e\.ts$/.test(process.argv[1])) {
  const violations: Violation[] = [];
  for (const file of [...sourceFiles(".forgejo/workflows/*.yml"), ...sourceFiles("scripts/**/*.sh")]) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:ci-exit-read-under-set-e - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Forgejo runs a step as bash -e -o pipefail: a failing command ends the step before $? or PIPESTATUS is read. Guard it: `cmd || rc=$?`, then read rc.");
    process.exit(1);
  }
  console.log("lint:ci-exit-read-under-set-e OK: every after-the-fact exit-code read in a workflow or a set -e script follows a guarded command.");
}
