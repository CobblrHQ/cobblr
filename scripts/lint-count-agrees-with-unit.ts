#!/usr/bin/env tsx
// A quantity beside a unit goes through quantityWithUnit or countOf, so the word agrees with the count
//
// THE BUG THIS PREVENTS. A yarn record read "3 hank" (2026-09-26): the number
// and the unit were put side by side as stored, and a unit is stored as one
// word whatever the count. Once a table lets people pick the word (ball, skein
// or hank), every hand-built "${qty} ${unit}" says it wrong at every count but
// one. The add-item summary Cobb shows was one of them ("Added Wool (3 hank)").
//
// THE RULE. A template literal or JSX run that puts a value straight in front
// of a bare unit value (`${qty} ${unit}`, `{p.qty} {p.unit}`) fails. Say it
// with quantityWithUnit(n, unit, resolved, known) or countOf(n, words) from
// @cobblr/platform-contract, or useUnits().format(n, unit, known) on a page.
// A genuine exception says `// count-unit-ok: <reason>` on the line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first draft flagged
// anything counted before anything unit-shaped, and caught the reconcile
// card's `${r.qty - r.units_count} ${... ? "is" : "are"}`, a count before a
// verb. So the second placeholder must be a plain name or member path that
// ENDS in `unit` (unit, p.unit, row.qty_unit), nothing computed. Measured
// amounts built this way ("160 m") are caught too, and are fixed the same
// way: quantityWithUnit keeps a measured unit's symbol.
//
// THE SECOND HALF: A COUNT BESIDE A LITERAL PLURAL (#5273). `${n} changes` is
// the same bug with the word typed in: it reads "1 changes" at exactly one
// count (a colour-change line said "1 colour changes"). A count-shaped value
// (count, total, qty, n, x.length, x.size ...) straight in front of a word
// ending in "s" fails; say it with countOf(n, "change"). A line that already
// branches on one (`n === 1 ? ... : ...`, `n > 1`) or is a console log is left
// alone, and a genuine exception says `// count-plural-ok: <reason>`, e.g. a
// sentence only ever shown for two or more.
//
// PROVE IT RED: put back `(${qty} ${unit})` in the inventory add-item summary,
// or `${hit.operations.length} changes` in the plan card.
//
//   npx tsx scripts/lint-count-agrees-with-unit.ts   (pnpm lint count-agrees-with-unit)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "web/src", "packages"];

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

/** A value, whitespace, then a bare name/member path ending in `unit`. */
const SIDE_BY_SIDE = [
  /\$\{[^}]+\}\s+\$\{\s*[\w$.?]*[uU]nit\s*\}/,
  /\{\s*[\w$.?()]+\s*\}\s+\{\s*[\w$.?]*[uU]nit\s*\}/,
];

/** A count-shaped value, whitespace, then a lower-case word ending in "s". */
const COUNT_VALUE =
  String.raw`(?:[\w$.?]*(?:[cC]ount|[tT]otal|[qQ]ty|[qQ]uantity|length|size)\w*|n|k|\w+\.size)`;
/** One modifier may sit between ("1 colour changes"), unless it is a small
 *  joining word ("3 of items", "n in places"). */
const JOINERS = "of|in|on|to|the|and|for|with|from|at|by|a|an|is|are|were|was|will|can|that|or|not|but|as|per|off|into|than|over";
const BESIDE_PLURAL = new RegExp(String.raw`(?<!=)\{\s*${COUNT_VALUE}\s*\}\s+(?:(?!(?:${JOINERS})\b)[a-z][a-z-]*\s+)?([a-z][a-z-]*s)\b`);
/** Words that end in "s" and are not plurals. */
const NOT_PLURAL = new Set(["is", "has", "was", "as", "this", "its", "plus", "less", "pass", "across", "unless", "status", "process"]);
/** The line already says what one reads like, or is a log. */
const GUARDED = /[!=]==? ?1\b|[<>]=? ?1\b|\bconsole\./;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/count-unit-ok: \S/.test(line)) continue;
    const plural = BESIDE_PLURAL.exec(line);
    if (plural && !NOT_PLURAL.has(plural[1]!) && !GUARDED.test(line) && !/countOf|quantityWithUnit|count-plural-ok: \S/.test(line)) {
      out.push({ file, line: i + 1, what: `a count beside a literal plural "${plural[1]}": ${line.trim().slice(0, 120)}` });
    }
    if (SIDE_BY_SIDE.some((re) => re.test(line))) {
      out.push({ file, line: i + 1, what: `a count beside a bare unit: ${line.trim().slice(0, 120)}` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:count-agrees-with-unit - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:count-agrees-with-unit OK`);
