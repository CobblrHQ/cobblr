// The one reader of `git status --porcelain`. Plain ESM so node can run it
// straight from a publish script and tsx from a lint; types in git-porcelain.d.mts.
//
// Porcelain puts the two status columns first and the path from column 3, so a
// line for a file modified in the work tree only starts with a SPACE (" M x").
// Every git helper in scripts/ trims its output, which eats that space on the
// FIRST line, and a fixed slice(3) then drops the path's first character. That
// shipped twice: push-registry read "EADME.md", and lint:changelog-names-ui read
// zero entries and passed (2026-09-13). So the lines are parsed by their columns,
// which is right whether or not the block was trimmed, and nothing else in
// scripts/ runs the command (lint:porcelain-parse).
import { execFileSync } from "node:child_process";

/** Rename and copy lines read `R  old -> new`; the path that exists now is `new`. */
function pathOf(rest) {
  const arrow = rest.indexOf(" -> ");
  return arrow === -1 ? rest : rest.slice(arrow + 4);
}

/** Each entry of a porcelain block: the two-column status and the path. Tolerates
 *  a trimmed block (the first line's leading space gone) and a trailing newline. */
export function parsePorcelain(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Untrimmed: columns 0-1 are the status, column 2 a space. Trimmed first
    // line: a one-character status and then the space.
    const m = line.match(/^([ MADRCU?!]{2})\s(.*)$/) ?? line.match(/^([MADRCU?!])\s(.*)$/);
    if (!m) continue;
    out.push({ status: m[1].length === 1 ? ` ${m[1]}` : m[1], path: pathOf(m[2]) });
  }
  return out;
}

/** Runs the command and parses it. `cwd` for a repo other than the current one. */
export function workingTreeStatus(cwd) {
  const raw = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parsePorcelain(raw);
}

/** Just the paths that differ from HEAD, tracked or not, in one repo. */
export function workingTreePaths(cwd) {
  return workingTreeStatus(cwd).map((e) => e.path);
}
