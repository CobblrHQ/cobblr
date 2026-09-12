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
// THE SAME TRAP, ONE LEVEL DOWN: a fragment built up from fragments. `||`
// (jsonb merge, text concat) is "any other operator" in Postgres, and binary
// `+` / `-` bind TIGHTER than that, so
//
//   let expr = sql`coalesce(metadata, '{}'::jsonb)`;
//   expr = sql`${expr} || ${set}::jsonb`;
//   expr = sql`${expr} - ${key}::text`;
//
// compiles to `metadata || set - 'key'`, which Postgres reads as
// `metadata || (set - 'key')`: the key is removed from the bag being merged in
// (where it never was) and stays on the row. inventory's restore-part did
// exactly this (found 2026-09-12): undoing a restock put the count and the
// dates back and left the lot the restock had started on the record, because
// the lot was the one key to REMOVE while the dates were keys to SET. Each
// template on its own reads fine; only the composition is wrong, and no type
// system sees inside a template literal.
//
// So the second check expands `${name}` where `name` is assigned a `sql`
// template in the same file, and refuses a composition that has a `||` and a
// `+` / `-` at the same top level. The fix is parens at every step:
//
//   expr = sql`(${expr} || ${set}::jsonb)`;
//   expr = sql`(${expr} - ${key}::text)`;
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

/**
 * The binary operators at a fragment's top level (paren depth 0, outside
 * string literals) that matter for precedence against each other: `||`, and
 * the arithmetic `+` / `-` that bind tighter. `->`, `->>`, `#-`, `#>` and a
 * `--` comment are not subtraction and are skipped; `::` casts and `*` (which
 * also means "every column") are left alone to keep this exact.
 *
 * `${…}` interpolations are transparent: a scalar becomes a bound parameter,
 * a fragment is inlined VERBATIM, and only the second kind can carry an
 * operator of its own. The caller expands those.
 */
function topLevelOperators(fragment: string): Set<"||" | "+" | "-"> {
  const ops = new Set<"||" | "+" | "-">();
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i];
    const next = fragment[i + 1];
    if (c === "'") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth !== 0) continue;
    else if (c === "|" && next === "|") {
      ops.add("||");
      i++;
    } else if (c === "-" && (next === ">" || next === "-")) {
      i++;
      if (next === "-") break;
    } else if (c === "#" && (next === "-" || next === ">")) {
      i++;
    } else if ((c === "+" || c === "-") && /\s/.test(fragment[i - 1] ?? " ") && /[\s$]/.test(next ?? " ")) {
      ops.add(c);
    }
  }
  return ops;
}

/** Every `${name}` at the fragment's top level, so a fragment interpolated
 *  inside parens (`(${expr})`) is left alone: its own precedence is contained. */
function topLevelInterpolations(fragment: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i];
    if (c === "'") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "$" && fragment[i + 1] === "{" && depth === 0) {
      const m = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(fragment.slice(i));
      if (m?.[1]) names.push(m[1]);
    }
  }
  return names;
}

/** The templates each identifier is assigned in this file, by name: both
 *  `const expr = sql\`…\`` and a later `expr = sql\`…${expr}…\``. */
function templatesByName(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /(?:\b(?:let|const|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;]+?)?\s*=\s*sql(?:<[^>]*>)?`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] ?? "";
    if (!name || name === "sql") continue;
    (out.get(name) ?? out.set(name, []).get(name)!).push(m[2] ?? "");
  }
  return out;
}

/** The operators a fragment carries at its top level once every fragment it
 *  inlines at top level is expanded, transitively. `seen` stops a fragment
 *  that is built up in a loop (`expr = sql\`${expr} …\``) from recursing
 *  forever; its own operators are already counted on the first visit. */
function expandedOperators(fragment: string, byName: Map<string, string[]>, seen: Set<string>): Set<string> {
  const ops = new Set<string>(topLevelOperators(fragment));
  for (const name of topLevelInterpolations(fragment)) {
    if (seen.has(name)) continue;
    seen.add(name);
    for (const inner of byName.get(name) ?? []) for (const op of expandedOperators(inner, byName, seen)) ops.add(op);
  }
  return ops;
}

const failures: string[] = [];
let fragments = 0;
let compositions = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("sql`") && !src.includes("sql<")) continue;

    // Second check: `||` against `+` / `-` across a composed fragment.
    const byName = templatesByName(src);
    const seenFragments = new Set<string>();
    const reAll = /sql(?:<[^>]*>)?`([^`]*)`/g;
    let f: RegExpExecArray | null;
    while ((f = reAll.exec(src)) !== null) {
      const fragment = f[1] ?? "";
      if (!fragment.includes("||") && !/[+-]/.test(fragment)) continue;
      compositions++;
      const ops = expandedOperators(fragment, byName, new Set());
      if (!ops.has("||") || !(ops.has("+") || ops.has("-"))) continue;
      const line = src.slice(0, f.index).split("\n").length;
      const key = `${file}:${line}`;
      if (seenFragments.has(key)) continue;
      seenFragments.add(key);
      failures.push(
        `${file}:${line}: sql\`${fragment.trim().slice(0, 74)}…\`\n` +
          `      mixes || with + or - at one level (its own text, or a fragment it inlines). ` +
          `+ and - bind tighter than ||, so a || b - 'k' is a || (b - 'k'): the key is never ` +
          `removed from a. Put parens around each step: sql\`(${"${expr}"} || …)\`, sql\`(${"${expr}"} - …)\`.`,
      );
    }

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
  console.error("✗ lint-sql-or-precedence: a raw SQL fragment does not group the way it reads:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ sql-or-precedence lint: ${fragments} raw fragment(s) with OR, all safely grouped; ` +
    `${compositions} fragment(s) with || or arithmetic, none mixing them at one level`,
);
process.exit(0);
