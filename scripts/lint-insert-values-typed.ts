#!/usr/bin/env tsx
// An insert's values are typed against the table, never cast with as never: the cast hides a required column the insert leaves out, and the row then fails on every call.
//
// THE BUG THIS PREVENTS. inventory:add-category never set the categories table's required slug behind an as-never cast, so the action failed on every call (coverage walk, 2026-10-07)
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
//   npx tsx scripts/lint-insert-values-typed.ts   (pnpm lint insert-values-typed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

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
/** Where each insert cast as `never` sits in one file: the line of the cast. */
function castLines(src: string): number[] {
  const lines = src.split("\n");
  const at: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bas never\)/.test(lines[i] ?? "")) continue;
    // The cast closes a .values(...) that belongs to an insertInto.
    const back = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
    const values = back.lastIndexOf(".values(");
    if (values === -1 || !/insertInto\(/.test(back.slice(0, values + 1))) continue;
    at.push(i + 1);
  }
  return at;
}

/** Files that held casts when this lint landed, and how many. It only shrinks:
 *  a file with fewer than its number says so, so the number comes down. */
const BASELINE = JSON.parse(readFileSync(join(import.meta.dirname, "insert-values-typed-baseline.json"), "utf8")) as Record<string, number>;

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const casts = castLines(src);
  const allowed = BASELINE[file] ?? 0;
  if (casts.length > allowed) {
    for (const line of casts.slice(allowed)) out.push({ file, line, what: "an insert's values cast with `as never`: the cast hides any required column left out" });
  } else if (casts.length < allowed) {
    out.push({ file, line: 1, what: `holds ${casts.length} cast insert(s), the baseline says ${allowed}: lower it in scripts/insert-values-typed-baseline.json` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:insert-values-typed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Drop the cast and pass every required column; a jsonb value goes through JSON.stringify or the column's json helper");
  process.exit(1);
}
console.log(`lint:insert-values-typed OK`);
