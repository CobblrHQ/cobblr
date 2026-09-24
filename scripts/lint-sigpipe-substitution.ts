// A command substitution that pipes into an early-exiting consumer, inside a
// script that `set -o pipefail`, is a script that exits 141 having printed
// nothing.
//
// `head -20` closes the pipe on its 20th line. The producer then takes SIGPIPE
// and dies 141, `pipefail` promotes that to the pipeline's status, and `set -e`
// ends the script. The assignment has already happened, so there is no error
// message and no partial output — the script simply stops.
//
// The reason this needs a lint rather than care is that it is TIMING-dependent.
// A pipe holds ~64KB, so a producer whose entire output fits is finished before
// the consumer exits and nothing is ever signalled. The same line works for
// months and then fails the first time the input grows past the buffer.
//
// scripts/deploy-gap.sh had exactly this (2026-08-08): `git log … | head -20`,
// so it exited 141 and printed nothing whenever more than 20 unshipped commits
// existed — which is to say only ever when it had something to report. It is
// the gate the shipping-a-pr skill tells you to trust before saying a fix is
// live, and it had been failing open.
//
// Two ways to satisfy this:
//   1. Let the producer do its own limiting — `git log -n 20`, `sed -n 1p`,
//      `awk 'NR==1{print;exit}'`. No pipe, nothing to fail. Prefer this.
//   2. Append `|| true` when an empty result is a valid answer the script
//      already handles (reading the first line of a token file).
//
// A workflow step is the same trap with the guard rails removed. Forgejo runs a
// `run:` block under `bash -e -o pipefail`, so there a BARE pipeline into
// `head` is fatal too, not only one inside `$(...)`: the producer takes
// SIGPIPE, pipefail makes the pipeline 141, and -e fails the step. The
// docs-touched status did exactly this (2026-09-22): `printf "$code" | head
// -20` listed a mixed commit's non-doc paths, and on a merge commit bringing a
// month of main into a branch (3,500 paths, past the pipe buffer) it exited
// 141 and went red, on a status whose whole job is to say "a doc was touched".
// So every `run:` block in .forgejo/workflows is read too, bare pipelines
// included. The same two remedies apply; `sed -n '1,20p'` reads all of its
// input and so never closes the pipe early.
//
// The same flag has a quieter twin: a `grep` that finds NOTHING. grep exits 1
// on no match, pipefail makes that the pipeline's status, and `set -e` ends
// the script before it prints a word. worktree-triage.sh --commands ended in
// `printf "$SAFE" | grep '^    git worktree remove' | sed ...`: on a box with
// nothing to reap grep matched nothing, the script died before its `exit 0`,
// and autoclean (rightly) read the silent exit 1 as a dead triage, so every
// session start after a quiet day said the reaper FAILED (2026-09-23). So in a
// script that sets both `-e` and pipefail, a one-line pipeline with a `grep`
// stage, or an assignment `x=$(... grep ...)`, must say what "no match" means:
// `{ grep ... || true; }` when an empty result is an answer, `grep -q x
// <<<"$v"` in an `if` when it is a question (a PIPE into grep -q in the `if`
// is the SIGPIPE trap below). A condition, an `&&`/`||` chain and a
// multi-line pipeline are not judged for an empty grep; the last is a known gap.
//
// The condition is the same trap, reading a match as a MISS. `printf '%s\n'
// "$x" | grep -q tok || missing+=...` under pipefail: bash's printf can write
// the string and its newline separately, grep -q matches the first write and
// exits, the second write takes SIGPIPE, and pipefail turns the match into
// status 141, which the `||` reads as "not found". The CI box's cron-drift
// check did this with a crontab fixture that plainly held the line
// (2026-09-24, main red, and once before as #3511, both put down to the
// environment): timing-dependent, so it only fires under load. So in a
// pipefail script every pipeline into head / grep -q / grep -m is judged, not
// only one inside `$(...)`: in a condition, at the top level, anywhere. Fixes:
// a here-string (`grep -q tok <<<"$x"`, no pipe at all), `grep ... >/dev/null`
// (reads all of its input), or limit in the producer. Text in single quotes is
// never this shell's code (a payload for a remote shell, a printed hint), so
// it is blanked across lines before judging; so is a line with an escaped
// `\$(`, a remote payload in double quotes. Every .sh under scripts/ and
// deploy/ is read, subdirectories included: scripts/dev-rig was invisible to
// the first version of this lint.
//
// Run: npx tsx scripts/lint-sigpipe-substitution.ts

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["scripts", "deploy"];

/**
 * Consumers that close their input early, on purpose. The lookarounds keep `||`
 * out of it, so `[ -n "$head" ] || head="$(…)"` is not read as a pipe into
 * head(1).
 */
const EARLY_EXIT = /(?<!\|)\|(?!\|)\s*(head\b|grep\s+-[a-zA-Z]*q|grep\s+-[a-zA-Z]*m\s*\d)/;

const failures: string[] = [];
let checked = 0;

/** Every .sh under `dir`, subdirectories included. */
function walkSh(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSh(p));
    else if (name.endsWith(".sh")) out.push(p);
  }
  return out;
}

const shFiles = DIRS.flatMap(walkSh);

/** The source with every quoted string blanked (newlines kept) except the
 *  `$(...)` substitutions inside double quotes, which ARE this shell's code. A
 *  quoted string is otherwise a payload for a remote shell (`on_box '...'`,
 *  `filter="... | head -1"`) or a printed hint, never this script's pipeline.
 *  `#` comments are skipped. */
export function blankSingleQuoted(src: string): string {
  type St = { k: "code" } | { k: "single" } | { k: "double" } | { k: "subst"; depth: number };
  const stack: St[] = [{ k: "code" }];
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ?? "";
    const top = stack[stack.length - 1] ?? { k: "code" };
    if (top.k === "single") {
      if (c === "'") { stack.pop(); out += c; } else out += c === "\n" ? c : " ";
      continue;
    }
    if (top.k === "double") {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === "$" && src[i + 1] === "(") { stack.push({ k: "subst", depth: 0 }); out += "$("; i++; continue; }
      if (c === '"') { stack.pop(); out += c; continue; }
      out += c === "\n" ? c : " ";
      continue;
    }
    // code or subst
    if (c === "\\") { out += c + (src[i + 1] ?? ""); i++; continue; }
    if (c === "#" && (i === 0 || /[\s;]/.test(src[i - 1] ?? "")) && src[i - 1] !== "$") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      out += src[i] ?? "";
      continue;
    }
    if (c === "'") { stack.push({ k: "single" }); out += c; continue; }
    if (c === '"') { stack.push({ k: "double" }); out += c; continue; }
    if (c === "$" && src[i + 1] === "(") { stack.push({ k: "subst", depth: 0 }); out += "$("; i++; continue; }
    if (top.k === "subst") {
      if (c === "(") top.depth++;
      else if (c === ")") { if (top.depth === 0) stack.pop(); else top.depth--; }
    }
    out += c;
  }
  return out;
}

/** Why this (quote-blanked) line pipes into an early-exiting consumer, or null. */
export function earlyExitPipe(line: string): string | null {
  if (line.trimStart().startsWith("#")) return null;
  // `\$(` is escaped, so THIS shell never evaluates it: a remote payload or a
  // printed hint, which does not inherit this script's pipefail.
  if (/\\\$\(/.test(line)) return null;
  if (!EARLY_EXIT.test(line)) return null;
  if (/\|\|\s*true/.test(line)) return null;
  return /(?<!\\)\$\(/.test(line) ? "inside `$(...)`" : "in a pipeline (a condition reads the 141 as a miss)";
}

for (const file of shFiles) {
  const src = readFileSync(file, "utf8");
  if (!/set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(src)) continue;
  checked++;
  const lines = blankSingleQuoted(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const where = earlyExitPipe(lines[i] ?? "");
    if (!where) continue;
    failures.push(
      `${file}:${i + 1}: \`${(src.split("\n")[i] ?? "").trim().slice(0, 90)}\`\n` +
        `      pipes into an early-exiting consumer (head, grep -q, grep -m) ${where} while pipefail is on. ` +
        `The producer can take SIGPIPE after the consumer exits, and the pipeline is 141: ` +
        `no output from \`$(...)\`, or a match read as a miss. Use a here-string ` +
        `(\`grep -q x <<<"$v"\`), \`grep ... >/dev/null\`, or limit in the producer ` +
        `(\`git log -n 20\`, \`sed -n 1p\`).`,
    );
  }
}

// ── a grep that matches nothing, under -e and pipefail ──
/** The line with the text inside quotes removed, so a pipe in a string handed
 *  to a remote shell (`on_box "... | grep ..."`) or printed as a hint is not
 *  read as this script's own pipeline. */
export function unquoted(line: string): string {
  return line.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Why this line's grep can end the script when it matches nothing, or null. */
export function emptyGrepTrap(line: string, prev: string): string | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  // A continuation of, or the start of, a multi-line pipeline: not judged.
  if (/[|\\]\s*$/.test(prev.trim()) || /\|\s*$/.test(t)) return null;
  const assign = /^(?:local\s+|export\s+|readonly\s+)?[A-Za-z_]\w*="?\$\((.*)\)"?\s*$/.exec(t);
  if (assign) {
    const body = assign[1] ?? "";
    if (!/\bgrep\b/.test(unquoted(body))) return null;
    if (/\bgrep\s+-[a-zA-Z]*q/.test(body) || /\|\|/.test(body)) return null;
    return "an assignment whose $(...) greps: no match exits 1 and -e ends the script";
  }
  const bare = unquoted(t);
  if (/^(if|elif|while|until|!|for|case|echo|\[|\[\[|return|exit)\b/.test(bare)) return null;
  if (/\|\||&&/.test(bare)) return null;
  if (/<\(/.test(bare)) return null;
  if (!/(?<!\|)\|(?!\|)\s*grep\b|^grep\b[^|]*(?<!\|)\|(?!\|)/.test(bare)) return null;
  if (/\bgrep\s+-[a-zA-Z]*q/.test(bare)) return null;
  return "a pipeline with a grep stage: no match exits 1, pipefail and -e end the script with nothing printed";
}

let emptyChecked = 0;
for (const file of shFiles) {
  const src = readFileSync(file, "utf8");
  if (!/set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(src)) continue;
  if (!/set\s+-[a-zA-Z]*e/.test(src)) continue;
  emptyChecked++;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const why = emptyGrepTrap(lines[i] ?? "", i > 0 ? (lines[i - 1] ?? "") : "");
    if (!why) continue;
    failures.push(
      `${file}:${i + 1}: \`${(lines[i] ?? "").trim().slice(0, 90)}\`\n` +
        `      ${why}. Say what no match means: \`{ grep ... || true; }\` when empty is an answer, ` +
        `\`grep -q x <<<"$v"\` in an \`if\` when it is a question.`,
    );
  }
}


// ── workflow run: blocks (bash -e -o pipefail, so bare pipelines count) ──
const WF_DIR = ".forgejo/workflows";
let steps = 0;
for (const f of existsSync(WF_DIR) ? readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n)) : []) {
  const file = join(WF_DIR, f);
  for (const { line, n } of runBlockLines(readFileSync(file, "utf8"))) {
    if (line.trimStart().startsWith("#")) continue;
    if (!EARLY_EXIT.test(line)) continue;
    if (/\|\|\s*true/.test(line)) continue;
    failures.push(
      `${file}:${n}: \`${line.trim().slice(0, 90)}\`\n` +
        `      pipes into an early-exiting consumer in a workflow step, which runs under ` +
        `\`bash -e -o pipefail\`: once the producer outputs more than the pipe buffer holds ` +
        `it takes SIGPIPE, the pipeline is 141 and the step fails. Use \`sed -n '1,20p'\` ` +
        `(reads all of its input), limit in the producer, or append \`|| true\`.`,
    );
  }
  steps++;
}

/** The shell lines of every `run:` step: an inline `run: cmd`, or the indented
 *  body under `run: |` / `run: >`. */
export function runBlockLines(yaml: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    const rest = (m[2] ?? "").trim();
    if (rest && !/^[|>][-+]?$/.test(rest)) {
      out.push({ line: rest, n: i + 1 });
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() === "") continue;
      if (l.length - l.trimStart().length <= indent) break;
      out.push({ line: l, n: j + 1 });
      i = j;
    }
  }
  return out;
}

if (failures.length) {
  console.error("✗ lint-sigpipe-substitution: a script can die with no output (SIGPIPE 141, or a grep that matched nothing):");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ sigpipe-substitution lint: ${checked} pipefail script(s), ${emptyChecked} -e + pipefail script(s) for empty greps, and ${steps} workflow(s) clean`);
process.exit(0);
