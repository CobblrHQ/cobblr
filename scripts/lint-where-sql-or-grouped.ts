#!/usr/bin/env tsx
// A raw sql fragment passed to .where() keeps any OR inside parentheses, because Kysely ANDs it onto the other clauses as written and a bare OR escapes them.
//
// THE BUG THIS PREVENTS. a join link's pace check ended in a bare OR, so the claim matched and counted against another invite and let a third person through a limit of two (2026-09-28)
//
// THE RULE. In `.where(sql\`...\`)` (or `.where(sql<T>\`...\`)`), an `or`
// at the fragment's top level (not inside parentheses) fails: wrap the whole
// fragment in ( ). ORs inside a sub-select's own parentheses are fine.
//
// THE BOUNDARY. Only raw sql fragments handed straight to .where(): Kysely's
// own eb.or([...]) groups itself, and a fragment used elsewhere (a select
// expression, an order by) is not ANDed onto anything. Nothing has tested the
// boundary beyond that yet.
//
// Proven red on the join-link pace check as it was first written.
//
//   npx tsx scripts/lint-where-sql-or-grouped.ts   (pnpm lint where-sql-or-grouped)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

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
  const re = /\.where\(\s*(?:\/\/[^\n]*\n\s*)*sql(?:<[^>]*>)?`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("`", start);
    if (end < 0) continue;
    const body = src.slice(start, end).replace(/\$\{[^}]*\}/g, "x");
    let depth = 0;
    let bare = false;
    for (let k = 0; k < body.length; k++) {
      const c = body[k];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && /\bor\b/i.test(body.slice(k, k + 3)) && (k === 0 || /\W/.test(body[k - 1] ?? " "))) {
        bare = true;
        break;
      }
    }
    if (bare) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ file, line, what: "a raw sql fragment in .where() has an OR outside parentheses; wrap the whole fragment in ( )" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:where-sql-or-grouped - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:where-sql-or-grouped OK`);
