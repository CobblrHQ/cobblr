#!/usr/bin/env tsx
// A jsonb ARRAY column must be written as a JSON string, never as a JS array.
//
// WHY THIS IS A LINT: node-pg renders a JS array as a POSTGRES ARRAY literal
// ({a,b}), which a jsonb column rejects at runtime with "invalid input syntax
// for type json". Nothing catches it earlier - the Kysely column type is
// `unknown[]`, so passing an array is exactly what the types ask for, and it
// typechecks perfectly. A plain object is fine (node-pg serialises it as JSON),
// so the trap is specific to arrays and easy to reintroduce by "fixing" a type
// error the way I did on 2026-07-31: the cast was removed to satisfy tsc, and
// the whole 69-item import failed on the first row.
//
// The existing writers all use `JSON.stringify(x) as never` for this reason.
// This makes that convention checkable instead of folklore.
//
//   npx tsx scripts/lint-jsonb-array-writes.ts   (npm run lint:jsonb-array-writes)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Columns declared as jsonb ARRAYS in any module's Kysely schema. Derived from
 *  the schema itself, so a new one is covered the day it is added. */
function jsonbArrayColumns(): Set<string> {
  const cols = new Set<string>();
  const modules = join(ROOT, "modules");
  for (const mod of readdirSync(modules)) {
    const db = join(modules, mod, "src", "db.ts");
    try {
      if (!statSync(db).isFile()) continue;
    } catch {
      continue;
    }
    const src = readFileSync(db, "utf8");
    for (const m of src.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:\s*(?:Generated<unknown\[\]>|ColumnType<unknown\[\]|ColJsonbArr)/gim)) {
      cols.add(m[1]!);
    }
  }
  return cols;
}

const COLUMNS = jsonbArrayColumns();

/**
 * Pre-existing writes, grandfathered so this lint blocks NEW ones without
 * changing another module's behaviour on an unverified theory.
 *
 * `assets.flags` is a genuine `.values()` write of a JS array to a jsonb column
 * and looks like the same defect, but it has not been reproduced against a live
 * assets table - and the usual value is `[]`, which Postgres accepts as the
 * array literal `{}` and stores as an empty OBJECT rather than erroring. That
 * makes it a silent wrong-value rather than a crash, which is worth its own
 * look rather than a drive-by fix here.
 */
const BASELINE = new Set<string>([
  "modules/assets/src/api/assets.ts::flags",
]);

const offenders: Array<{ file: string; line: number; col: string; text: string }> = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * Every object literal that can become a row of column values: the argument of
 * `.values(` / `.set(`, and any `const x = { ... }` that is later spread into
 * one. The second case matters as much as the first - this codebase builds the
 * values object separately and spreads it, which is precisely where the bug
 * this lint exists for was written.
 *
 * A `res.json({...})` body or a `z.object({...})` schema is neither, so the
 * same property name there is correctly ignored.
 */
function writeRegions(src: string): Array<{ start: number; text: string }> {
  const regions: Array<{ start: number; text: string }> = [];
  const take = (from: number, open: string, close: string) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close) {
        depth--;
        if (depth === 0) {
          regions.push({ start: from, text: src.slice(from, i + 1) });
          return;
        }
      }
    }
  };
  for (const m of src.matchAll(/\.(?:values|set)\s*\(/g)) take(m.index! + m[0].length - 1, "(", ")");
  // `const values = {` / `const row = {` — an object built to be written.
  for (const m of src.matchAll(/\b(?:const|let)\s+\w*[Vv]alues?\w*\s*(?::[^=]+)?=\s*\{/g)) {
    take(m.index! + m[0].length - 1, "{", "}");
  }
  return regions;
}

/**
 * Assignments that become COLUMNS of the write.
 *
 * Not simply "depth 1": this codebase adds columns conditionally with
 * `...(cond ? { col: v } : {})`, which nests the key several braces deep while
 * still being a top-level column. A pure depth rule misses exactly that shape -
 * it missed the line this lint was written for.
 *
 * So instead: a key counts unless it sits INSIDE another key's object. That
 * excludes `pre_rerun: { candidates: [...] }` (a property of a value being
 * written into one jsonb column, serialised whole, never at risk) and includes
 * anything reached only through spreads, ternaries and parens.
 */
function columnAssignments(region: string): Array<{ key: string; value: string; offset: number }> {
  const out: Array<{ key: string; value: string; offset: number }> = [];
  // Each open brace is either a VALUE of some key ("owned") or transparent
  // scaffolding from a spread/ternary.
  const stack: boolean[] = [];
  let lastKey: string | null = null;
  for (let i = 0; i < region.length; i++) {
    const c = region[i]!;
    if (c === "{") {
      // `key: {` means everything inside belongs to that key.
      const before = region.slice(0, i).replace(/\s+$/, "");
      stack.push(before.endsWith(":"));
      lastKey = null;
      continue;
    }
    if (c === "}") {
      stack.pop();
      continue;
    }
    const m = /^([a-z_][a-z0-9_]*)\s*:\s*([^,\n]+)/i.exec(region.slice(i));
    if (m && (i === 0 || /[\s{,(?:]/.test(region[i - 1]!))) {
      lastKey = m[1]!;
      if (!stack.some(Boolean)) {
        out.push({ key: m[1]!, value: m[2]!.trim(), offset: i });
      }
      i += m[1]!.length; // step past the key only; the value may contain braces
    }
  }
  void lastKey;
  return out;
}

for (const file of walk(join(ROOT, "modules"))) {
  const src = readFileSync(file, "utf8");
  for (const region of writeRegions(src)) {
    for (const a of columnAssignments(region.text)) {
      if (!COLUMNS.has(a.key)) continue;
      if (/JSON\.stringify|sql`|^null\b|^undefined\b/.test(a.value)) continue;
      if (BASELINE.has(`${relative(ROOT, file)}::${a.key}`)) continue;
      const line = src.slice(0, region.start + a.offset).split("\n").length;
      offenders.push({ file, line, col: a.key, text: `${a.key}: ${a.value}`.slice(0, 110) });
    }
  }
}

if (offenders.length === 0) {
  console.log(
    `[lint:jsonb-array-writes] ✓ every write to a jsonb array column is JSON-encoded ` +
      `(${COLUMNS.size} column(s) watched, ${BASELINE.size} baselined).`,
  );
  process.exit(0);
}
console.error(`\n[lint:jsonb-array-writes] ✗ ${offenders.length} jsonb array write(s) that Postgres will reject:\n`);
for (const o of offenders) {
  console.error(`  ${relative(ROOT, o.file)}:${o.line}  ${o.col}\n      ${o.text}`);
}
console.error(
  `\nnode-pg renders a JS array as a Postgres ARRAY literal, which a jsonb column\n` +
    `rejects with "invalid input syntax for type json". It typechecks anyway, because\n` +
    `the Kysely column type is unknown[].\n\n` +
    `Write it as:  ${[...COLUMNS][0] ?? "col"}: JSON.stringify(value) as never\n`,
);
process.exit(1);
