#!/usr/bin/env tsx
// A web request that routinely asks whether something exists never reads a 404 as its answer: the route answers 200 with none, and a 404 the web meets on purpose says which kind it is.
//
// THE BUG THIS PREVENTS. The order page asked core-scan for a purchase line's received slots and a typed-in line has none, so the route said 404; every order page with one made a failing request, and the nightly walk counts a 4xx on a page as the page failing (#6268). Neither path lint could see it: the path was right and served, and they check that a path is served, never what a served route says to a question asked on every page.
//
// THE RULE. In web/src and packages/platform-web/src (tests apart), every place
// the code branches on a 404 answer (`status === 404`, `== 404`, `!== 404`)
// says which kind of 404 it is, on that line or the line above:
//
//   // 404-is: a-state: <why a person can meet it>     a deleted or expired thing opened from a link
//   // 404-is: an-older-api: <why>                      a web deployed ahead of its api asks the older door
//   // 404-is: a-module-off: <why>                      the module that serves it is not turned on
//
// A reason is required. What none of the three can be is the answer to a
// question the page asks routinely ("does this line have a row?", "does
// anything connected do this?"): that route answers 200 with none (an `if_any`
// door, orderLineSlotsIfAny) and the 404 stays for asking about a thing that
// must be there.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. It reads the branch, not the
// route: a route that answers 404 as its normal answer to a page nobody wrote
// a branch for is shown by the walk's noApiRefusals, which fails a page whose
// api calls any answered 4xx. The two are the pair: this one stops a branch
// that hides the refusal, the walk stops the refusal itself. Not yet tested
// against a near-miss.
//
// PROVE IT RED before you trust it green: it fails on any `status === 404`
// branch with no annotation.
//
//   npx tsx scripts/lint-a-refusal-is-never-the-normal-answer.ts   (pnpm lint a-refusal-is-never-the-normal-answer)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src"];

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
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bstatus\s*(?:===?|!==?)\s*404\b/.test(line)) continue;
    const said = `${lines[i - 1] ?? ""}\n${line}`.match(/\/\/\s*404-is:\s*(a-state|an-older-api|a-module-off)\s*:\s*(\S.*)/);
    if (!said) out.push({ file, line: i + 1, what: "a branch on a 404 that does not say which kind it is (// 404-is: a-state | an-older-api | a-module-off: <why>)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-refusal-is-never-the-normal-answer - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A routine question never gets a 404 for its answer: have the route answer 200 with none (an if_any door). A 404 the web meets on purpose says which kind: // 404-is: a-state | an-older-api | a-module-off: <why>");
  process.exit(1);
}
console.log(`lint:a-refusal-is-never-the-normal-answer OK`);
