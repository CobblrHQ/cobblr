#!/usr/bin/env tsx
// A bundle field whose name is an identifier (set_number, part_number, sku, isbn, serial, vin) declares field_role identifier, so every surface that decides 'the same product' can read it.
//
// THE BUG THIS PREVENTS. The Sets table's set_number shipped without the flag; two sets with different numbers were offered as one product (#2977).
//
// THE RULE. Every field def in bundles/*.json whose name is an identifier by
// the platform's list (same-product.ts: set_number, part_number, sku, mpn,
// serial_number, isbn, upc, ean, vin, ...; a bare "model" is a name as
// often as a number and is not held) carries `field_role: "identifier"`, or
// a `decode_role` of `identifier:<kind>`. A hidden native (`hidden: true`)
// is the module's own field and is declared there.
//
//   npx tsx scripts/lint-identifier-fields-declared.ts   (pnpm run lint:identifier-fields-declared)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { IDENTIFIER_FIELD_NAMES } from "../packages/platform-contract/src/same-product.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["bundles"];

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
    else if (/\.json$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch {
    return out;
  }
  const manifest = ((doc as { manifest?: unknown }).manifest ?? doc) as { provides_instances?: Array<{ instance_name?: string; field_defs?: Array<Record<string, unknown>> }> };
  for (const inst of manifest.provides_instances ?? []) {
    for (const f of inst.field_defs ?? []) {
      const name = typeof f.name === "string" ? f.name : "";
      if (!name || f.hidden === true || /^model$/i.test(name)) continue;
      if (!IDENTIFIER_FIELD_NAMES.test(name)) continue;
      const role = typeof f.field_role === "string" ? f.field_role : "";
      const decode = typeof f.decode_role === "string" ? f.decode_role : "";
      if (role === "identifier" || decode.startsWith("identifier:")) continue;
      const line = src.split("\n").findIndex((l) => new RegExp(`"name":\\s*"${name}"`).test(l)) + 1;
      out.push({ file, line, what: `${inst.instance_name ?? "?"}.${name} is an identifier field with no field_role "identifier"` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:identifier-fields-declared - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:identifier-fields-declared OK`);
