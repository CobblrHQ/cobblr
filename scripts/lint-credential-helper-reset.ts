#!/usr/bin/env tsx
/**
 * `git -c credential.helper=store` must be preceded by an empty `credential.helper=`.
 *
 * git treats credential.helper as a LIST and `-c` APPENDS to it. So supplying a
 * credential file does not replace an existing helper, it adds a second one — and
 * the globally configured helper is consulted FIRST. On a machine with
 * osxkeychain, or a box with a cached credential, git authenticates as whoever is
 * in that store and the file is never read.
 *
 * The failure is silent and looks like success: the push works, so nothing fails,
 * and the wrong account is recorded as the pusher. That is how commits published
 * by an automated pipeline came to be attributed to a maintainer's personal
 * account on a public repository, discovered only by reading the events API.
 *
 * A helper string of "" resets the list to empty (git-config(1), credential.helper),
 * so the fix is one extra `-c credential.helper=` immediately before.
 *
 * PERMANENT LINT.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(mjs|cjs|js|ts|sh|bash|yml|yaml)$/.test(f));

/**
 * An EMPTY helper: `credential.helper=` with nothing after it but a closing quote
 * and/or a separator. Every quoting style in this repo appears —
 * `-c credential.helper=`, `"credential.helper="`, `` `credential.helper=` ``,
 * `"credential.helper=",` in a JS argument array.
 *
 * The lookahead has to check what follows the closing quote, not just that a quote
 * is there. An earlier version stopped at the quote, which made
 * `credential.helper="$HELPER"` — a very much non-empty helper — read as a reset.
 */
const RESET = /credential\.helper=(?:["'`](?=[\s,)\]]|$)|(?=[\s,)\]]|$))/;

/**
 * Any helper being SET to something. Not just `store`: an inline `!f() { ... }`
 * helper appends to the same list and inherits the same problem, and the publish
 * workflow uses exactly that form.
 */
const HELPER_SET = /credential\.helper=(?!["'`]?(?:[\s,)\]]|$))/;
/** Prose about this rule mentions the bad form by necessity; only code counts. */
const isComment = (l: string) => /^\s*(\/\/|#|\*|<!--)/.test(l);

const violations: { file: string; line: number; text: string }[] = [];

/** This file quotes the bad form in its own diagnostic, which is not a comment and
 *  would otherwise be reported as a violation of itself. Caught by the pre-push hook
 *  on the first commit, because the scan reads `git ls-files` and an untracked file
 *  is invisible to it. */
const SELF = "scripts/lint-credential-helper-reset.ts";

for (const rel of files) {
  if (rel === SELF) continue;
  let src: string;
  try {
    src = readFileSync(`${ROOT}/${rel}`, "utf8");
  } catch {
    continue;
  }
  if (!HELPER_SET.test(src)) continue;

  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    if (isComment(line)) continue;
    const at = line.search(HELPER_SET);
    if (at < 0) continue;
    // The reset may sit on this line before the store helper, or on one of the two
    // lines above when the command is wrapped — both shapes appear in this repo.
    // Only text BEFORE the store helper counts: a reset after it would wipe the
    // helper just supplied.
    const before = [lines[i - 2] ?? "", lines[i - 1] ?? ""]
      .filter((l) => !isComment(l))
      .concat(line.slice(0, at))
      .join("\n");
    if (!RESET.test(before)) {
      violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 96) });
    }
  }
}

if (violations.length) {
  console.error("credential.helper set without resetting the helper list first:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(`
git treats credential.helper as a LIST and appends to it, so the helper above is
consulted only AFTER any helper already configured on the machine. The command still
succeeds, authenticated as whatever account that other helper holds, and the wrong
pusher is recorded. Nothing fails, which is why this is worth a lint.

Add an empty helper immediately before, which resets the list:

  git -c "credential.helper=" -c "credential.helper=store --file=$CRED" push ...
  git -c credential.helper= -c credential.helper="$HELPER" clone ...
`);
  process.exit(1);
}

console.log(`credential-helper-reset: OK (${files.length} files scanned)`);
