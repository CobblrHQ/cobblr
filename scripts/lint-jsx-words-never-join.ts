#!/usr/bin/env tsx
// A word on the line after a JSX value keeps the space between them.
//
// THE BUG THIS PREVENTS. Configuration → AI read 'Cobblrruns in basic mode' (#8873, 2026-10-28)
//
// THE RULE. JSX drops a text's leading whitespace when it holds a line
// break, so `Off, {productName()}` ending one line and `runs in basic mode`
// starting the next renders "Off, Cobblrruns in basic mode". A `{value}`
// that renders text, followed by a new line that starts with a letter or a
// digit, fails; so does a line ending in a word with a `{value}` starting the
// next. The fix is the value and the word on one line, or `{" "}` between.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first pass also judged
// elements and flagged 326 places, nearly all an icon before its label
// (`<Plus />` then "Add"), which the button's gap spaces. A second pass judged
// every expression and flagged 44 `{" "}`, the space itself. Both are out:
// only a value that renders text counts, never an element, a condition, or a
// string that carries its own space. The rule reads the parsed TSX
// (lib/jsx-joined-words.ts), so text in strings and attributes is never seen.
//
//   npx tsx scripts/lint-jsx-words-never-join.ts   (pnpm lint jsx-words-never-join)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { joinedWordsIn } from "./lib/jsx-joined-words.ts";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages", "ops-console/src"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  return joinedWordsIn(file, src).map((v) => ({ file, line: v.line, what: `renders joined to the value before it: "${v.text}"` }));
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:jsx-words-never-join - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Put the value and the word on one line, or add {\" \"} after the value.");
  process.exit(1);
}
console.log(`lint:jsx-words-never-join OK`);
