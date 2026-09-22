#!/usr/bin/env tsx
// A shipped script never embeds a `python3 -c '...'` / `node -e '...'` body
// that contains a single quote of its own.
//
// THE BUG THIS PREVENTS. 2026-09-22 (#3405): `live_health` in
// scripts/lib/shippable.sh parsed /healthz with an inline
// `python3 -c '...'`, and a line added that morning carried its own quotes,
// `x.get('name','?')`. Each inner quote CLOSED the shell's string, python
// received `x.get(name,?)` and died with a SyntaxError, `2>/dev/null` hid it
// and `|| echo "? ? ? ?"` supplied the fallback. Every health number on every
// surface then read as unreadable, which switched off the pending-migrations
// refusal (written after a container served queries against tables it had not
// shaped for four hours) and the 5xx read, and the fallback named a cause it
// had not checked. The repo's own rule is file-first for exactly this; this is
// the mechanical form of it.
//
// THE RULE. In a shipped shell script (scripts/**.sh, .forgejo/workflows/**),
// an inline interpreter body opened with a single quote may not contain a
// single quote. Put the body in a FILE beside the script and call it by path:
// a file crosses every shell boundary verbatim. A body with no quote of its
// own is fine and stays; so is a heredoc, which is the other file-shaped form.
// No opt-out: the quote is the hazard, and an "it works today" body is one
// edit away from the one that did not.
//
// PROVEN RED 2026-09-22 against cb0a74e15's scripts/lib/shippable.sh, the
// commit that shipped the broken line.
//
//   npx tsx scripts/lint-no-inline-script-quotes.ts   (pnpm run lint:no-inline-script-quotes)
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

interface Violation { file: string; line: number; what: string }
const violations: Violation[] = [];

/** `python3 -c '` / `node -e '` / `node --input-type=module -e '` openings. */
const OPEN = /\b(python3?|node)\b[^\n|;]*?\s-(?:c|e)\s+'/;

/** The shell ends a '...' string at the FIRST quote, so the question is what
 *  sits immediately after that quote. A space, a pipe, a redirect or a paren
 *  is the author closing the body and carrying on in shell. A letter, a
 *  comma, a bracket or a colon means the string ended INSIDE the interpreter's
 *  code and the interpreter will get a fragment: `x.get('name','?')` closes
 *  after `x.get(` and python receives `x.get(name,?)`. One pass, no
 *  backtracking, and it reads the same way the shell does. */
function check(file: string, src: string): void {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = OPEN.exec(line);
    if (!m) continue;
    let rest = line.slice((m.index ?? 0) + m[0].length);
    let at = i;
    while (!rest.includes("'") && at + 1 < lines.length && at - i < 200) {
      at += 1;
      rest = lines[at] ?? "";
    }
    const q = rest.indexOf("'");
    if (q < 0) continue;                       // never closes: not this rule's business
    const after = rest.slice(q + 1);
    if (!/^[A-Za-z0-9_,:.[\]{}]/.test(after)) continue;   // shell continues: the body closed cleanly
    violations.push({
      file,
      line: at + 1,
      what: `inline ${m[1]} body: the shell's string ends at this quote and ${m[1]} would receive a fragment (${(rest.slice(Math.max(0, q - 12), q + 12)).trim()})`,
    });
  }
}

for (const f of [...sourceFiles("scripts/**/*.sh"), ...sourceFiles(".forgejo/workflows/*.yml")]) {
  check(f, readFileSync(f, "utf8"));
}

if (violations.length) {
  console.error(`lint:no-inline-script-quotes - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Put the body in a FILE beside the script and call it by path (scripts/lib/health-fields.py is the precedent): a file crosses every shell boundary verbatim.");
  process.exit(1);
}
console.log("lint:no-inline-script-quotes OK: no shipped script embeds a quoted interpreter body that carries its own quote.");
