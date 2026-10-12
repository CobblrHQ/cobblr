#!/usr/bin/env tsx
// An optional field in a request body takes blank and null as none: it is written with optionalField/optionalText/optionalUuid (or .nullish()), never a bare .optional() that refuses null.
//
// THE BUG THIS PREVENTS. 2026-10-12 #6068: the Knowledge Base New entry form sent a blank code as null, the route's schema refused it, and Create failed with no reason shown.
//
// THE RULE. In a request-body schema (a z.object named *Create, *Update, *Patch,
// *Body, *Input, *Edit, *Add, *New, *Post or *Put, in a module's src/api or the
// kernel's routes), a text, number, enum or uuid field written as a bare
// `.optional()` fails: a form sends an empty box as null or "", and that must
// mean "none". Write it with optionalField / optionalText / optionalUuid from
// @cobblr/platform-contract/optional-fields, or `.nullish()`. A genuine exception
// carries `// none-refused-ok: <reason>` on the line.
//
// THE BASELINE. scripts/optional-fields-baseline.json lists the fields that still
// refuse null (`file::schema::field`). It only shrinks: a field not in it fails,
// and an entry whose field no longer refuses null fails as stale, so converting a
// field means deleting its line.
//
// THE BOUNDARY. Booleans are out (false is already "none"), and so are arrays,
// records and objects. Only a field written on one line is read.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-optional-fields-accept-none.ts   (pnpm lint optional-fields-accept-none)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["modules", "api/src"];
const BASELINE = "scripts/optional-fields-baseline.json";
const SCHEMA = /^\s*(?:export\s+)?const (\w+)\s*=\s*z\.object\(/;
const REQUEST_NAME = /(Create|Update|Patch|Body|Input|Edit|Add|New|Post|Put)/i;
const FIELD = /^\s*(\w+): z\.(?:string|number|enum|coerce|nativeEnum|literal)\b.*\.optional\(\)/;
const OK = /nullish|nullable|optionalField|optionalText|optionalUuid|none-refused-ok: \S/;

interface Violation {
  file: string;
  line: number;
  what: string;
  key: string;
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
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

const inScope = (file: string) => /\/src\/api\//.test(file) || /^api\/src\/.*\/?routes\//.test(file) || /^api\/src\/routes\//.test(file);

/** Every bare-optional request field in one file. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!/from "zod"/.test(src)) return out;
  let schema: string | null = null;
  src.split("\n").forEach((line, i) => {
    const m = SCHEMA.exec(line);
    if (m) schema = m[1] ?? null;
    else if (/^\}\)/.test(line)) schema = null;
    if (!schema || !REQUEST_NAME.test(schema)) return;
    const f = FIELD.exec(line);
    if (!f || OK.test(line)) return;
    out.push({ file, line: i + 1, key: `${file}::${schema}::${f[1]}`, what: `${schema}.${f[1]} is a bare .optional(): a blank box sent as null is refused; use optionalField / optionalText / optionalUuid` });
  });
  return out;
}

const found: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (inScope(file)) found.push(...check(file, readFileSync(file, "utf8")));
const baseline = new Set<string>(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
const seen = new Set(found.map((v) => v.key));
const violations: Violation[] = found.filter((v) => !baseline.has(v.key));
for (const key of baseline)
  if (!seen.has(key)) violations.push({ file: BASELINE, line: 1, key, what: `stale baseline entry ${key}: that field no longer refuses null, delete the line` });

if (violations.length) {
  console.error(`lint:optional-fields-accept-none - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:optional-fields-accept-none OK`);
