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
// BETTER THAN BEING WATCHED HERE: spell the column's WRITE type as a string —
// `ColumnType<unknown[], string | undefined, string>` — and passing a JS array
// stops typechecking at all. That needs no `as never` (which silences every
// other error on the line too) and no lint. digifab_print_rule_state.fired is
// the first column to do it; module_field_defs.choices is the second, and the
// first in the platform schema. This lint stays for the columns typed the loose
// way, and for the shape it CANNOT see: a literal handed to a helper that
// writes it, where the value never appears at a `.values(` call at all
// (2026-08-29 — that hole let an unencoded write through this lint into a
// review).
//
// IT WATCHES THE PLATFORM SCHEMA TOO, since 2026-09-22. It did not, and that
// is how module_field_defs.choices shipped broken straight past it: the column
// list came from `modules/*/src/db.ts` alone, so every jsonb array in
// `api/src/db/schema.ts` was invisible and so was every writer under
// `api/src`. The value was dropped inside a catch, nothing logged above debug,
// and the vocabulary a whole feature depends on simply never grew. See
// `platformJsonbArrayColumns` for why the platform set is an INTERSECTION with
// the migrations rather than a second regex over the schema.
//
//   npx tsx scripts/lint-jsonb-array-writes.ts   (pnpm run lint jsonb-array-writes)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { blankNonCode, columnAssignments, writeRegions } from "./lib/jsonb-write-scan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Columns declared as jsonb ARRAYS in any module's Kysely schema. Derived from
 *  the schema itself, so a new one is covered the day it is added. */
function moduleJsonbArrayColumns(): Set<string> {
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

/**
 * The same columns in the PLATFORM schema, which this lint could not see until
 * `module_field_defs.choices` shipped broken through it (#3223 step 2).
 *
 * It cannot be read the module way. `api/src/db/schema.ts` spells these columns
 * with their real element type (`string[] | null`, `ApprovalRemedy[]`,
 * `Generated<NotificationAction[] | null>`), never `unknown[]`, so the module
 * regex matches none of them. But "array-typed in schema.ts" is not the answer
 * either: five platform columns (`scopes`, `enabled_features`, `demo_unlocks`,
 * `delivered_via`, `kinds`) are real Postgres `text[]`, where a JS array is
 * exactly RIGHT and `JSON.stringify` would be the bug. Flagging those would
 * break the build for everyone to catch nothing.
 *
 * So the set is an intersection of two independent sources: array-typed in
 * schema.ts AND declared `jsonb` in a platform migration. No column name is
 * currently declared both jsonb and array, but a name that ever is gets
 * dropped rather than guessed at — a false positive here costs everybody, a
 * false negative only leaves the status quo.
 */
function platformJsonbArrayColumns(): Set<string> {
  const jsonb = new Set<string>();
  const pgArray = new Set<string>();
  const migrations = join(ROOT, "api", "migrations", "platform");
  let files: string[] = [];
  try {
    files = readdirSync(migrations).filter((f) => f.endsWith(".sql"));
  } catch {
    return new Set();
  }
  for (const f of files) {
    const sql = readFileSync(join(migrations, f), "utf8");
    for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+jsonb\b/gi)) jsonb.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+[a-z]+\[\]/gi)) pgArray.add(m[1]!.toLowerCase());
  }
  const cols = new Set<string>();
  const schema = join(ROOT, "api", "src", "db", "schema.ts");
  let src = "";
  try {
    src = readFileSync(schema, "utf8");
  } catch {
    return cols;
  }
  for (const m of src.matchAll(/^\s*([a-z_][a-z0-9_]*)\??\s*:\s*[^;\n]*\[\]/gim)) {
    const col = m[1]!.toLowerCase();
    if (jsonb.has(col) && !pgArray.has(col)) cols.add(col);
  }
  return cols;
}

function jsonbArrayColumns(): Set<string> {
  return new Set([...moduleJsonbArrayColumns(), ...platformJsonbArrayColumns()]);
}

const COLUMNS = jsonbArrayColumns();

/** Nothing is grandfathered: the one pre-existing hit turned out to be a live
 *  bug (assets could not be created with flags at all) and was fixed rather
 *  than baselined. */
const BASELINE = new Set<string>([]);

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

for (const file of [...walk(join(ROOT, "modules")), ...walk(join(ROOT, "api", "src"))]) {
  const src = blankNonCode(readFileSync(file, "utf8"));
  for (const region of writeRegions(src)) {
    for (const a of columnAssignments(region.text)) {
      if (!COLUMNS.has(a.key)) continue;
      // Safe: JSON-encoded inline, encoded by a named helper (jsonbArray /
      // toJsonb), a raw SQL fragment, or an explicit null.
      if (/JSON\.stringify|jsonbArray\(|toJsonb\(|sql`|^null\b|^undefined\b/.test(a.value)) continue;
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
