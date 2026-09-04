// A shared shell helper must not assume it is running inside the repo.
//
// scripts/lib/deploy-state.sh read `git rev-parse origin/main` with a bare
// `git`, so it resolved the CALLER's working directory. new-worktree.sh has
// moved on by the time it prints, so every read came back empty and the status
// line rendered as:
//
//     main        ?
//     :nightly    not readable (git fetch failed)
//
// which is the worst possible failure: it printed, so it looked like it had
// run, and the number it was invented to stop people guessing at was simply
// absent. Nothing failed. Nothing was logged.
//
// A lib is sourced by callers it does not control - a hook, a script that cd's,
// a worktree that no longer exists - so "we are in the repo" is an assumption it
// cannot make. Scope reads with `git -C "$repo"`, resolving $repo from
// BASH_SOURCE rather than $PWD.
//
// The existing libs are sourced only from scripts that do run in the repo, so
// they are not broken today. They still say so out loud, because an assumption
// nothing records is one the next person cannot see they are relying on:
//
//     # cwd-repo: <why this lib may assume $PWD is the checkout>

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "scripts/lib");
// Reads that answer "what commit / branch / ref", i.e. the ones whose answer
// silently changes with the working directory.
const REPO_READ = /(^|[^-\w])git\s+(rev-parse|rev-list|merge-base|for-each-ref|describe|symbolic-ref|show-ref)\b/;

const offenders: Array<{ file: string; line: number; text: string }> = [];

for (const f of readdirSync(LIB).filter((n) => n.endsWith(".sh"))) {
  const src = readFileSync(join(LIB, f), "utf8");
  if (/^\s*#\s*cwd-repo:/m.test(src)) continue; // acknowledged, with a reason
  src.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("#")) return;
    if (!REPO_READ.test(line)) return;
    if (/git\s+-C\b/.test(line)) return;
    offenders.push({ file: `scripts/lib/${f}`, line: i + 1, text: line.trim().slice(0, 90) });
  });
}

if (offenders.length) {
  console.error("lint:shell-lib-git-cwd - a shared lib reads git from the CALLER's directory:\n");
  for (const o of offenders) console.error(`  ${o.file}:${o.line}\n    ${o.text}\n`);
  console.error(
    "A lib is sourced by callers it does not control, so $PWD is not reliably the\n" +
      "checkout. deploy-state.sh made this assumption and printed \"main ?\" from\n" +
      "new-worktree.sh - it looked like it had run, and said nothing.\n\n" +
      "Either scope the read:\n" +
      '  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; git -C "$repo" rev-parse ...\n' +
      "or record why this lib may assume otherwise:\n" +
      "  # cwd-repo: <reason>\n",
  );
  process.exit(1);
}
console.log("lint:shell-lib-git-cwd - shared shell libs do not read git from the caller's directory.");
