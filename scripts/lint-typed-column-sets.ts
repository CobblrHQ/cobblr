#!/usr/bin/env tsx
// A module's column list (what a list may search, sort, filter or compare on) is typed against its table with columnSet<Row>() or textSearchWhere's typed columns, never a plain new Set of strings.
//
// THE BUG THIS PREVENTS. List resolvers kept their search columns as plain
// strings, and two named columns their tables do not have: `description` on
// purchases_orders and `title` on projects_projects. Every search reaching
// those kinds raised `column "…" does not exist`, the platform answered an
// empty list, and orders and projects were missing from search, pickers and
// the assistant on every surface from 2026-09-01 until a server log was read
// (#3824). The search columns are now typed through `textSearchWhere`'s
// `ColumnOf<eb>`; the sort / filter / compare sets are the same kind of list,
// and a `new Set([...])` of names is invisible to the type checker.
//
// THE RULE. Under modules/*/src and api/src, a constant whose name ends in
// SORTABLE, NATIVE, COMPARABLE, FILTERABLE or SEARCHABLE is built with
// `columnSet<Row>()([...])`, so each name is checked against the table's row
// type. A set that genuinely is not a list of one table's columns (sort
// ALIASES that map to qualified refs) says so on the line before:
// `// COLUMN-SET-EXEMPT: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. By NAME, not by shape:
// `new Set([...])` of strings is everywhere (verbs, kinds, statuses), and
// judging every one would bury the rule in exemptions. The five suffixes are
// the names every resolver in the tree used for column lists (17 sites,
// 2026-09-28). purchases' ITEM_SORTABLE is the one exemption: its keys are
// aliases whose columns live in ITEM_SORT_COL.
//
// PROVE IT RED: with any one converted set put back to `new Set([`, this fails
// naming it.
//
//   npx tsx scripts/lint-typed-column-sets.ts   (pnpm lint typed-column-sets)
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
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /\bconst\s+([A-Z_]*(?:SORTABLE|NATIVE|COMPARABLE|FILTERABLE|SEARCHABLE))\s*(?::[^=]+)?=\s*new Set\(/.exec(line);
    if (!m) continue;
    if (/\/\/ COLUMN-SET-EXEMPT: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: `${m[1]} is a plain new Set of column names; use columnSet<Row>()([...]) so a missing column fails typecheck` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:typed-column-sets - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:typed-column-sets OK`);
