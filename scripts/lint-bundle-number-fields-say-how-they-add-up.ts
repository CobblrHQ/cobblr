#!/usr/bin/env tsx
// A number or money field a bundle ships or a module contributes says how it adds up in a group's summary (aggregate: sum, per_unit or none), and a module's own number field that reads as one item's property (per ball, each, /) says so too, so no per-unit value is ever summed.
//
// THE BUG THIS PREVENTS. Yarn by weight summed length per ball across yarns (167 + 211 = 378) and every bundle's years, temperatures and sizes were added up the same way (#5079, 2026-10-07)
//
// THE RULE. Three places, one question: how does this field add up?
//   - every field definition a bundle ships (bundles/*.json, generated from
//     web/src/lib/featured-bundles.ts) of type number or money carries
//     aggregate: "sum", "per_unit" or "none";
//   - every number or money field a module contributes (contributes.fieldDefs)
//     carries it too;
//   - a module's own entity-kind field (provides.entityKinds[].fields) that
//     reads as one item's property (readsPerUnit: a name with _per_ or _each,
//     a label with " / " or "each") says per_unit or none.
// There is no opt-out: the declaration IS the decision, and the three answers
// are always available (@cobblr/platform-contract/field-aggregate).
//
// THE BOUNDARY. A module's other native numbers (a quantity, a count already
// meant to be added) default to sum and are not asked: their meaning is the
// module's, and the readsPerUnit test is what catches the ones that are not.
//
// PROVED RED on the bundles as they stood before #5079 (60 fields in 26
// bundles, among them yarn's length per ball).
//
//   npx tsx scripts/lint-bundle-number-fields-say-how-they-add-up.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readsPerUnit } from "../packages/platform-contract/src/field-aggregate.ts";

interface Violation { file: string; what: string }
interface FieldLike { name?: unknown; type?: unknown; money?: unknown; aggregate?: unknown; display_label?: unknown; label?: unknown }

const violations: Violation[] = [];
const AGGREGATES = new Set(["sum", "per_unit", "none"]);
const isNumber = (f: FieldLike) => f.type === "number" || f.type === "money" || !!f.money;

function walk(o: unknown, file: string, path: string) {
  if (Array.isArray(o)) {
    o.forEach((v, i) => walk(v, file, `${path}[${i}]`));
    return;
  }
  if (!o || typeof o !== "object") return;
  const rec = o as FieldLike & Record<string, unknown>;
  if (/field_defs\[\d+\]$/.test(path) && typeof rec.name === "string" && isNumber(rec) && !AGGREGATES.has(String(rec.aggregate))) {
    violations.push({ file, what: `${path} "${rec.name}" is a ${String(rec.type)} field with no aggregate: sum | per_unit | none` });
  }
  for (const [k, v] of Object.entries(rec)) walk(v, file, path ? `${path}.${k}` : k);
}

for (const name of readdirSync("bundles").sort()) {
  if (!name.endsWith(".json") || name === "bundle-versions.lock.json") continue;
  const file = join("bundles", name);
  walk(JSON.parse(readFileSync(file, "utf8")), file, "");
}

const seen = new Set<string>();
for (const dir of readdirSync("modules").sort()) {
  const file = join("modules", dir, "src", "module.ts");
  if (!existsSync(file)) continue;
  let manifest: { contributes?: { fieldDefs?: FieldLike[] }; provides?: { entityKinds?: Array<{ id: string; fields?: FieldLike[] }> } };
  try {
    manifest = ((await import(pathToFileURL(join(process.cwd(), file)).href)) as { default: typeof manifest }).default;
  } catch (err) {
    violations.push({ file, what: `could not load the manifest to read its fields: ${(err as Error).message}` });
    continue;
  }
  for (const f of manifest?.contributes?.fieldDefs ?? []) {
    const key = `${file} ${String(f.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isNumber(f) && !AGGREGATES.has(String(f.aggregate))) violations.push({ file, what: `contributes.fieldDefs "${String(f.name)}" is a number field with no aggregate: sum | per_unit | none` });
  }
  for (const kind of manifest?.provides?.entityKinds ?? []) {
    for (const f of kind.fields ?? []) {
      if (!isNumber(f) || typeof f.name !== "string") continue;
      const label = typeof f.label === "string" ? f.label : typeof f.display_label === "string" ? f.display_label : null;
      if (readsPerUnit({ name: f.name, display_label: label }) && f.aggregate !== "per_unit" && f.aggregate !== "none") {
        violations.push({ file, what: `${kind.id} field "${f.name}" reads as one item's property but would be summed: say aggregate: "per_unit" or "none"` });
      }
    }
  }
}

if (violations.length) {
  console.error(`lint:bundle-number-fields-say-how-they-add-up - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}  ${v.what}`);
  console.error(
    "Say how the field adds up in a group's summary: sum (a count, an amount spent), per_unit (one item's length, weight or price, totalled as value x quantity) or none (a year, a size, a temperature, a rating). " +
      "Bundles: edit web/src/lib/featured-bundles.ts, then npx tsx scripts/sync-bundles.ts.",
  );
  process.exit(1);
}
console.log(`lint:bundle-number-fields-say-how-they-add-up OK`);
