#!/usr/bin/env tsx
// A multiline EditField names the most its save takes (maxLength, from the contract's limit the route also reads), so text past it is said and kept, never refused on save and lost.
//
// THE BUG THIS PREVENTS. A 9,000-character note pasted into a part's Notes on a phone was refused by the save and gone after a reload, with nothing said (2026-11-21, #4115)
//
// THE RULE. A `<EditField … multiline …>` or an `editFieldItem(key, { …
// multiline: true … })` also passes `maxLength`, the same constant the route's
// schema refuses past (RECORD_NOTES_MAX for a record's Notes). A long-text
// field whose save takes any length says why on a `// any-length-ok:` line on
// the line above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A one-line field is not
// judged: a name's limit is held by its own input (PART_NAME_MAX). Tests are
// not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-long-text-field-says-its-limit.ts   (pnpm lint a-long-text-field-says-its-limit)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The text from `at` to the close of the element or call it opens. */
function spanFrom(src: string, at: number, jsx: boolean): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") {
      depth--;
      if (!jsx && depth === 0) return src.slice(at, i + 1);
    } else if (jsx && depth === 0 && ch === ">") return src.slice(at, i + 1);
  }
  return src.slice(at);
}

function check(file: string, src: string): Violation[] {
  if (file.endsWith("packages/platform-web/src/EditField.tsx")) return [];
  const lines = src.split("\n");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const out: Violation[] = [];
  const judge = (at: number, span: string) => {
    if (!/\bmultiline\b(?!\s*:\s*false)(?!=\{false\})/.test(span) || /\bmaxLength\b/.test(span)) return;
    const line = lineOf(at);
    if (/any-length-ok: \S/.test(lines[line - 2] ?? "")) return;
    out.push({ file, line, what: "a long-text field with no maxLength: text past the save's limit is refused and lost" });
  };
  for (const m of src.matchAll(/<EditField\b/g)) judge(m.index!, spanFrom(src, m.index!, true));
  for (const m of src.matchAll(/\beditFieldItem\(/g)) judge(m.index!, spanFrom(src, m.index! + "editFieldItem".length, false));
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-long-text-field-says-its-limit - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Pass maxLength={RECORD_NOTES_MAX} (@cobblr/platform-contract/record-limits, the constant the route's schema reads), or // any-length-ok: <why the save takes any length>");
  process.exit(1);
}
console.log(`lint:a-long-text-field-says-its-limit OK`);
