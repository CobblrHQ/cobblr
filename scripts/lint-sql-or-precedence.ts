// A raw SQL fragment with a top-level OR, dropped into a chained query builder,
// silently loses its grouping.
//
// Kysely joins chained `.where()` calls with AND and injects an `sql` fragment
// VERBATIM. AND binds tighter than OR, so
//
//   .where("message_id", "=", id)
//   .where("processed_at", "is not", null)
//   .where(sql`items <> '0' or note`)
//
// compiles to
//
//   WHERE message_id = $1 AND processed_at is not null AND items <> '0' OR note
//
// which Postgres reads as `(… AND … AND …) OR note`. The OR escapes every
// condition before it. The query stops being scoped to the row you asked about
// and starts matching on the last clause alone.
//
// This is not hypothetical and it is not cheap. `receipt-ingest.ts` had exactly
// this in its inbound-email duplicate check (found 2026-08-12). The moment one
// archived email recorded `note=true`, that single row satisfied the escaped OR
// for EVERY later message, so every forwarded receipt was rejected as a
// "duplicate" of it. Nineteen days, every message silently dead-lettered, and
// the archive's own reprocess path was blocked by the same clause. Nothing
// errored; the endpoint returned 200 the whole time.
//
// It reviews clean, too — the surrounding code and its comment were correct
// about the intent. Only the compiled SQL was wrong, and no type system sees
// inside a template literal.
//
// The fix is always the same: wrap the fragment's own disjunction in parens, so
// it cannot interact with whatever the builder puts around it.
//
//   .where(sql`(items <> '0' or note)`)
//
// Run: npx tsx scripts/lint-sql-or-precedence.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules", "packages", "web/src"];

/** Builder methods whose argument is ANDed with its siblings. */
const COMBINING = /\.(where|andWhere|having|on|orWhere)\s*\(\s*$|\.(where|andWhere|having|on)\s*\(/;

/**
 * Is there a bare OR at the fragment's top level (paren depth 0)?
 *
 * OR only. A top-level AND is harmless in both directions — `x AND (a AND b)`
 * is `x AND a AND b`, and `x OR (a AND b)` is `x OR a AND b` — because AND
 * already binds tighter. Flagging AND turns three correct queries into noise,
 * which is how a lint gets disabled.
 *
 * Depth tracking is the whole point: `coalesce((a)::boolean, false) or b` has
 * an OR at depth 0 and is a bug, while `(a or b)` does not and is the fix.
 */
function hasTopLevelDisjunction(fragment: string): boolean {
  let depth = 0;
  // Strip single-quoted literals so `'0' or '1'` inside a string is not read as
  // an operator. Doubling ('') is escaped-quote in SQL, handled by the scan.
  let inStr = false;
  const lowered = fragment.toLowerCase();
  for (let i = 0; i < lowered.length; i++) {
    const c = lowered[i];
    if (c === "'") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && lowered.startsWith(" or ", i)) {
      // An interpolation (${…}) is opaque, but it cannot change the fact that a
      // bare operator sits at depth 0 outside it.
      return true;
    }
  }
  return false;
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let fragments = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("sql`") && !src.includes("sql<")) continue;

    // Each `sql\`…\`` template, with its start offset so we can look behind it.
    const re = /sql(?:<[^>]*>)?`([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const fragment = m[1] ?? "";
      if (!/\sor\s/i.test(fragment)) continue;
      fragments++;
      if (!hasTopLevelDisjunction(fragment)) continue;

      // Only flag it where the builder will AND it with siblings. A fragment
      // used as a whole query, a select item, or an orderBy has nothing wrapped
      // around it, so its own precedence is its own business.
      const before = src.slice(Math.max(0, m.index - 240), m.index);
      if (!COMBINING.test(before)) continue;

      const line = src.slice(0, m.index).split("\n").length;
      failures.push(
        `${file}:${line}: sql\`${fragment.trim().slice(0, 74)}…\`\n` +
          `      has a bare top-level OR and is passed to a combining builder method. ` +
          `Chained clauses join with AND, and AND binds tighter than OR, so this ` +
          `fragment's disjunction will swallow the conditions around it. ` +
          `Wrap the fragment in its own parens: sql\`(a or b)\`.`,
      );
    }
  }
}

if (failures.length) {
  console.error("✗ lint-sql-or-precedence: a raw SQL fragment can escape its own WHERE:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ sql-or-precedence lint: ${fragments} raw fragment(s) with OR, all safely grouped`);
process.exit(0);
