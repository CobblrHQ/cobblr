#!/usr/bin/env tsx
// Every AI call that needs structured output passes its output schema, so whichever provider answers is held to it and a shape-ignoring answer is caught; a call whose answer is free text says why.
//
// THE BUG THIS PREVENTS. 2026-10-11 (#5790): a local Gemma 4 read every receipt price right in a JSON layout of its own, and the reader kept nothing
//
// THE RULE. Every `ai.invoke(` call in source passes `output_schema` in its
// input (the router checks the answer against it, ai-output-shape.ts), or the
// line just above the call says `// FREE-TEXT: <why>`: a chat turn, an OCR
// read, a personal document's labelled lines, a parser that takes prose.
//
// THE BOUNDARY. Source files under api/src, modules and packages, tests
// aside. The call's own argument is read to its closing parenthesis, so a
// schema passed in a variable counts when the argument names
// `output_schema`. Proven red on the 33 calls of 2026-10-11, none of which
// named a shape.
//
//   npx tsx scripts/lint-ai-calls-name-their-shape.ts   (pnpm lint ai-calls-name-their-shape)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const call = /\.ai\.invoke\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < src.length && depth) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    const arg = src.slice(m.index, j);
    const line = src.slice(0, m.index).split("\n").length;
    // Words in a comment are not a call.
    const own = src.split("\n")[line - 1]!.trim();
    if (own.startsWith("//") || own.startsWith("*") || own.startsWith("/*")) continue;
    const above = src.split("\n").slice(Math.max(0, line - 3), line).join("\n");
    if (/\boutput_schema\b/.test(arg) || /\/\/ FREE-TEXT: \S/.test(above)) continue;
    out.push({ file, line, what: "an AI call with no output_schema and no FREE-TEXT reason" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:ai-calls-name-their-shape - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("pass input.output_schema (JSON Schema of the keys the parser reads), or put // FREE-TEXT: <why> on the line above the call");
  process.exit(1);
}
console.log(`lint:ai-calls-name-their-shape OK`);
