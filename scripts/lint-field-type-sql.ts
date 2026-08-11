// The database must accept every field type the code can produce.
//
// `module_field_defs.type` carries a CHECK constraint listing the legal types.
// It is the EIGHTH place the field-type list is written and the only one in
// SQL, so `lint:field-type-enum` — which unified the seven TypeScript copies —
// cannot see it. That gap shipped: `member` passed zod validation, typecheck,
// 125 lints and 202 unit test files, then died on
//
//   new row for relation "module_field_defs" violates check constraint
//   "module_field_defs_type_check"
//
// the first time a real request hit a real database. A feature that was green
// everywhere and worked nowhere.
//
// So this compares FIELD_TYPE_VALUES against the CHECK as the LATEST migration
// leaves it. Add a type without widening the constraint and the build fails
// here instead of in production.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "api/migrations/platform");
const CONSTRAINT = "module_field_defs_type_check";
const CONTRACT = join(ROOT, "packages/platform-contract/src/index.ts");

/** Read FIELD_TYPE_VALUES as TEXT rather than importing it: lints run from the
 *  repo root without workspace resolution, and importing the package fails in
 *  CI while passing locally — which is how the first version of this lint went
 *  red on the very PR it was written for. */
function codeTypes(): string[] {
  const src = readFileSync(CONTRACT, "utf8");
  const m = src.match(/export const FIELD_TYPE_VALUES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!m) {
    console.error("Could not find FIELD_TYPE_VALUES in platform-contract — was it renamed?");
    process.exit(1);
  }
  // Strip comments before pulling literals, or a type named in prose counts.
  const body = m[1]!.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return (body.match(/"([a-z-]+)"/g) ?? []).map((x) => x.slice(1, -1));
}

// Migrations are numbered and applied in filename order, so the last file that
// (re)defines the constraint is the one the database ends up with.
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

let latest: { file: string; types: Set<string> } | null = null;
for (const file of files) {
  const sql = readFileSync(join(DIR, file), "utf8");
  const add = sql.split(/ADD\s+CONSTRAINT/i).slice(1).find((chunk) => chunk.includes(CONSTRAINT));
  if (!add) continue;
  // Take the CHECK body up to its closing paren-ish region, then pull literals.
  const body = add.slice(0, add.indexOf(";") === -1 ? undefined : add.indexOf(";"));
  const types = new Set((body.match(/'([a-z-]+)'/g) ?? []).map((m) => m.slice(1, -1)));
  if (types.size > 0) latest = { file, types };
}

if (!latest) {
  console.error(
    `No migration defines ${CONSTRAINT}. Either it was renamed (update this lint) or the\n` +
      `constraint was dropped (the database now accepts any string as a field type).`,
  );
  process.exit(1);
}

const code = new Set<string>(codeTypes());
const missingInSql = [...code].filter((t) => !latest.types.has(t));
const extraInSql = [...latest.types].filter((t) => !code.has(t));

if (missingInSql.length > 0 || extraInSql.length > 0) {
  const lines: string[] = [];
  if (missingInSql.length > 0) {
    lines.push(
      `The database would REJECT ${missingInSql.map((t) => `'${t}'`).join(", ")}, which the code can produce.`,
      `  Add a migration widening ${CONSTRAINT} (additive, so an older api is unaffected).`,
    );
  }
  if (extraInSql.length > 0) {
    lines.push(
      `The constraint allows ${extraInSql.map((t) => `'${t}'`).join(", ")}, which is not in FIELD_TYPE_VALUES.`,
      `  Either the type was removed from the code (leave the constraint: dropping a value`,
      `  breaks existing rows) or it is a typo in the migration.`,
    );
  }
  console.error(
    `Field types disagree between the code and the database:\n` +
      `  code (FIELD_TYPE_VALUES): ${[...code].join(", ")}\n` +
      `  sql  (${latest.file}): ${[...latest.types].join(", ")}\n\n` +
      lines.join("\n"),
  );
  process.exit(1);
}

console.log(`lint:field-type-sql - the CHECK accepts every field type the code can produce ✓`);
