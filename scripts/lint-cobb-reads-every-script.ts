#!/usr/bin/env tsx
// Cobb's code never strips a message or a record name down to ASCII letters: a character class like [^a-z0-9] needs a reason that it is matching English keywords or building an identifier.
//
// THE BUG THIS PREVENTS. Cobb answered 'where is 日本語', 'where is Ключ' and 'where is SER7724-00025' with nothing, because the question was normalized to ASCII before the name was looked up (#7817, 2026-10-22).
//
// THE RULE. A negated ASCII character class, [^a-z...], in Cobb's code fails:
// it strips or splits on every letter outside English, so a name in Japanese,
// Arabic or Cyrillic disappears and a hyphenated serial falls in two. Use
// normQuestion or wordsOf (modules/core-ai/src/question-text.ts), or a
// \p{L}\p{N} class with the u flag. A class that is genuinely about English
// keywords or an ASCII identifier (a slug, a file name, a field key) opts out
// with `// ascii-only: <why>` on the same line or the line above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only NEGATED classes: a
// positive [a-z]+ that reads an English keyword ("how many", "most common")
// keeps working whatever the name around it is, and the field-key capture in
// count-answers is one. The cassette file slug in providers/replay.ts is a
// negated class that is right as it is (a file name), so the opt-out exists.
// Tests are not judged: they spell the words they test.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-cobb-reads-every-script.ts   (pnpm lint cobb-reads-every-script)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/core-ai/src", "packages/workspace-tools/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\[\^a-z/i.test(line)) continue;
    const above = lines[i - 1] ?? "";
    if (/\/\/ ascii-only: \S/.test(line) || /^\s*\/\/ ascii-only: \S/.test(above)) continue;
    out.push({ file, line: i + 1, what: "an ASCII-only class drops every letter outside English; use normQuestion/wordsOf or \\p{L}, or say why with // ascii-only: <why>" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:cobb-reads-every-script - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:cobb-reads-every-script OK`);
