#!/usr/bin/env tsx
// A workflow that tells a label change apart compares github.event.action with both labeled and label_updated, because Forgejo sends label_updated
//
// THE BUG THIS PREVENTS. 2026-10-09: ci.yml matched only 'labeled', so every label (train:queued, merge-machinery) re-ran a ready pull request's whole CI and cancelled the real run; Forgejo's payload says label_updated (run 40971)
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Name the near-miss that
// made the scope what it is: the thing that looked like a violation, is not
// one, and is why the rule stops where it does. A scope drawn by a real
// near-miss keeps its precision; one drawn by imagination does not. If
// nothing has tested the boundary yet, say that instead of inventing one.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-workflow-label-action.ts   (pnpm lint workflow-label-action)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo/workflows"];

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
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*#/.test(line)) continue;
    if (/github\.event\.action\s*[!=]=\s*'labeled'/.test(line) && !/'label_updated'/.test(line)) {
      out.push({ file, line: i + 1, what: "compares github.event.action with 'labeled' only; Forgejo sends 'label_updated', so this branch never matches a label change there" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workflow-label-action - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("write (github.event.action == 'labeled' || github.event.action == 'label_updated')");
  process.exit(1);
}
console.log(`lint:workflow-label-action OK`);
