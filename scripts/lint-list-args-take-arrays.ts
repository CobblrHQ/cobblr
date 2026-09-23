#!/usr/bin/env tsx
// A handler reads a list argument with a reader that takes a JSON array as well as a comma string (namesOf, readListArg); never str(args.x).split or splitNames(str(args.x)), which read an array as nothing and refuse a value that was there.
//
// THE BUG THIS PREVENTS. platform:group-fields read fields with splitNames(str(args.fields)); the model supplied every argument correctly with fields as a JSON array and was told three times they were required (the 2026-09-22 nightly, #3142)
//
// THE RULE. In a handler file (a file whose name carries "handler", under
// api/src/platform or a module's src/api) a line FAILS when it reads an
// argument as a string and then splits it: `splitNames(str(args.x))`,
// `str(args.x).split(`, `String(args.x).split(`. `str()` of an array is
// "" and `String()` of one is "a,b" only by accident, so a JSON array (the
// shape the invoke tool says any value may take, and the natural one for a
// model) reads as nothing, and the refusal that follows says "required"
// about a value that was there. It PASSES when the list is read with
// `namesOf(args.x)` (the api handlers' reader) or `readListArg(args, "x")`
// (the contract's), both of which take an array, a JSON string and a comma
// string alike. No opt-out: there is no list argument a caller may not
// send as an array.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-list-args-take-arrays.ts   (pnpm run lint list-args-take-arrays)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/platform", "modules"];

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

const isHandlerFile = (file: string): boolean => /handler/i.test(file.split("/").pop() ?? "") && /(^api\/src\/platform\/|^modules\/[^/]+\/src\/api\/)/.test(file);
const SPLIT_A_STRING = /splitNames\(\s*str\(\s*args\.[\w$]+\s*\)\s*\)|\b(?:str|String)\(\s*args\.[\w$]+\s*\)\s*\.split\(/g;

/** The check. Return every violation in one file; an empty array is a pass.
 *  Scanned over the whole source, since `str(args.choices)\n.split(` was
 *  the shape three of the four readers took. */
function check(file: string, src: string): Violation[] {
  if (!isHandlerFile(file)) return [];
  const out: Violation[] = [];
  for (const m of src.matchAll(SPLIT_A_STRING)) {
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file, line, what: `${m[0].replace(/\s+/g, " ").trim()} reads an array as nothing; use namesOf(args.x) or readListArg(args, "x")` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:list-args-take-arrays - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Read the argument with namesOf (api handlers) or readListArg (the contract), which take arrays, JSON strings and comma strings alike.");
  process.exit(1);
}
console.log(`lint:list-args-take-arrays OK`);
