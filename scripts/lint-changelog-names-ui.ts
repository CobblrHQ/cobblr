#!/usr/bin/env tsx
// A type: feature changelog entry that names a control a person presses (button, sheet, menu, picker, tab, toggle, card, chip, link) ships in a change that also touches web/src, modules/*/src/ui or a bundle manifest, or says ui: none (<reason>).
//
// THE BUG THIS PREVENTS. changelog.d/receipt-autofile.md (2026-08-24, type:
// feature) promised "One button files everything waiting" and its `## docs`
// described a File everything control with three piles. The commit that
// carried it (47f10dae2) touched modules/core-scan/src/api/inbox.ts and
// services/autofile.ts and nothing under web/. The entry published, the
// public docs described the endpoint, and the button did not exist until
// #2809 on 2026-09-12, nineteen days later. Nothing at authoring time could
// have said so (#2444, #2830).
//
// THE RULE. Diff-scoped, like lint:changelog: only changelog.d entries added
// or changed since the merge-base with main are read, so a tree with no new
// entry costs nothing. A new entry is read whole; an entry that already
// existed is read only on the lines this change added to it, because the
// claim being judged is the one this change makes. For each such entry with `type: feature`, the prose
// and the `## docs` section are scanned for a word naming a control a person
// presses (CONTROL_WORDS below; the vocabulary lives here and nowhere else).
// If one is found, the same diff must touch a path where a control can ship:
// web/src/**, modules/<name>/src/ui/**, or a bundle manifest (bundles/*.json,
// since a bundle can add a surface). If it does not, the entry fails, naming
// the word it found and the paths it looked for. A feature whose control
// already existed (copy on an existing button, a wire behind it, a relay)
// opts out with a line in the entry, where a reader sees it:
// `ui: none (<reason>)`, in the frontmatter or the body.
//
// Improvements and fixes are out of scope: a fix naming a button is usually
// fixing the button. The vocabulary is nouns for things pressed, not verbs,
// so "you can now filter by author" passes and "a Filter button" does not.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A docs publish run (#3510)
// stamps `docs_published:` on 149 old feature entries whose controls shipped
// weeks earlier in their own PRs; reading each whole refused a pure publish
// with 90 violations. So a modified entry is judged on its added lines, and a
// stamp line carries no control word. An edit that ADDS "a Split button" to an
// old entry still fails, on that line.
//
// PROVEN RED on 47f10dae2's shape: the receipt-autofile entry present in the
// diff with no web/ path, and the lint named "button". Green once the same
// diff carried a web/src path, and green on `ui: none (...)`.
//
//   npx tsx scripts/lint-changelog-names-ui.ts   (pnpm run lint changelog-names-ui)
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { check, type Violation } from "./lib/changelog-names-ui.js";
import { workingTreePaths } from "./lib/git-porcelain.mjs";

/** Where the rule bites: the entries this change adds or edits. */
const ROOTS = ["changelog.d"];

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function tryGit(cmd: string): string | null {
  try {
    return git(cmd);
  } catch {
    return null;
  }
}
function findBase(): string | null {
  for (const ref of ["origin/main", "forgejo/main", "main"]) {
    const mb = tryGit(`merge-base HEAD ${ref}`);
    if (mb) return mb;
  }
  return null;
}


/** The paths this change touches: the branch's diff against main in CI, plus
 *  the working tree locally, so an entry written but not yet committed is
 *  judged before it is pushed. */
function changedPaths(base: string): string[] {
  const committed = base === tryGit("rev-parse HEAD") ? [] : git(`diff --name-only ${base}...HEAD`).split("\n");
  const working = workingTreePaths();
  return [...new Set([...committed, ...working].filter(Boolean))];
}

/** The lines this change added to an entry, as 1-based numbers in the working
 *  tree's copy, or null when the entry is new (every line is the change's).
 *  Diffed against the merge-base so committed and uncommitted edits both
 *  count. */
function addedLines(base: string, file: string): Set<number> | null {
  if (tryGit(`cat-file -e ${base}:${file}`) === null) return null;
  const diff = tryGit(`diff -U0 ${base} -- ${file}`) ?? "";
  const out = new Set<number>();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
}

{
  const base = findBase();
  if (!base) {
    console.log("[lint:changelog-names-ui] no base ref (origin/main) — skipping");
    process.exit(0);
  }
  const changed = changedPaths(base);
  const entries = changed.filter(
    (f) => ROOTS.some((r) => f.startsWith(`${r}/`)) && f.endsWith(".md") && !f.endsWith("/README.md") && existsSync(f),
  );
  const violations: Violation[] = [];
  for (const f of entries) violations.push(...check(f, readFileSync(f, "utf8"), changed, addedLines(base, f)));

  if (violations.length) {
    console.error(`lint:changelog-names-ui - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A feature that names a control ships the control. Fix the change, or write the opt-out with its reason.");
    process.exit(1);
  }
  console.log(`lint:changelog-names-ui OK (${entries.length} changed entr${entries.length === 1 ? "y" : "ies"} read)`);
}
