#!/usr/bin/env tsx
// A line ending in a backslash is never followed by a comment line, in a workflow run block or a tracked shell script: the comment ends the command and the next line runs as a new one
//
// THE BUG THIS PREVENTS. The showcase publish report in e2e-suite.yml was
//
//     curl -s --max-time 20 -X POST \
//       -H "x-ci-run: …" -H "x-ci-workflow: E2E-suite" \
//       # Its OWN outcome, not job.status: …
//       -H "x-ci-job: showcase-publish" … \
//       --data-binary @/tmp/publish.log http://…/ci-log \
//       && echo "shipped publish log to sink" || echo "(sink POST failed)"
//
// A backslash joins the NEXT line, the next line is a comment, and a comment
// runs to the end of the line: the command ends there. curl ran with the two
// headers and no URL, `-H` ran as a command of its own (`-H: command not
// found`), and `|| echo "(sink POST failed)"` printed into a step marked
// continue-on-error. No publish report reached the sink from 2026-08-16 until
// #3474, and nothing said so. lint:ci-sink read this very step and passed it,
// because it checks that the POST exists, not that it parses.
//
// THE RULE. In `.forgejo/workflows/*.yml` (the whole file: the only place a
// line ends in a backslash there is a run block) and every tracked `*.sh`, a
// line whose code ends in an unescaped `\` must not be followed by a line
// that is only a comment. Blank lines after a continuation are reported too,
// for the same reason: they end the command just as silently. Move the
// comment above the command, or after it. There is no opt-out: the shape is
// never what anybody meant.
//
//   npx tsx scripts/lint-continuation-comment.ts   (pnpm lint continuation-comment)
import { repoFiles } from "./lib/repo-files.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LINT_ROOT = process.env.COBBLR_LINT_ROOT || ".";

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The files the rule bites: every workflow, and every tracked shell script
 *  (tracked, so a scratch script in _tmp is not judged; a fixture tree that is
 *  not a git repository falls back to a walk). */
export function targets(root = LINT_ROOT): string[] {
  const out: string[] = [];
  const wf = join(root, ".forgejo/workflows");
  if (existsSync(wf)) for (const n of readdirSync(wf)) if (/\.ya?ml$/.test(n)) out.push(join(".forgejo/workflows", n));
  try {
    out.push(...repoFiles(["*.sh"], root));
  } catch {
    const walk = (d: string): void => {
      for (const n of readdirSync(join(root, d), { withFileTypes: true })) {
        if (n.name === "node_modules" || n.name.startsWith(".")) continue;
        const rel = d ? `${d}/${n.name}` : n.name;
        if (n.isDirectory()) walk(rel);
        else if (n.name.endsWith(".sh")) out.push(rel);
      }
    };
    walk("");
  }
  return out;
}

/** A line whose code ends in a continuation: an odd run of backslashes at the
 *  end (`\\` is a literal backslash, not a continuation), and not itself a
 *  comment (a `\` at the end of a comment continues nothing). */
function continues(line: string): boolean {
  if (/^\s*#/.test(line)) return false;
  const m = line.match(/(\\+)\s*$/);
  return !!m && m[1]!.length % 2 === 1 && /\\$/.test(line.trimEnd());
}

export function check(src: string, file: string): Violation[] {
  const lines = src.split("\n");
  const found: Violation[] = [];
  let heredoc: string | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    // Inside a here-document every line is data, backslashes included.
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const hd = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (hd && !continues(line)) {
      heredoc = hd[1]!;
      continue;
    }
    if (!continues(line)) continue;
    const next = lines[i + 1]!;
    if (/^\s*#/.test(next)) {
      found.push({ file, line: i + 2, what: "a comment line after a line ending in `\\`: the comment ends the command, and the line after it runs as a new one. Move the comment above the command." });
    } else if (next.trim() === "") {
      found.push({ file, line: i + 2, what: "a blank line after a line ending in `\\`: it ends the command, and the line after it runs as a new one." });
    }
  }
  return found;
}

function main(): void {
  const all: Violation[] = [];
  for (const rel of targets()) {
    let src: string;
    try {
      src = readFileSync(join(LINT_ROOT, rel), "utf8");
    } catch {
      continue;
    }
    all.push(...check(src, rel));
  }
  if (all.length) {
    console.error(`lint:continuation-comment - ${all.length} violation(s):`);
    for (const v of all) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    process.exit(1);
  }
  console.log("lint:continuation-comment OK");
}

main();
