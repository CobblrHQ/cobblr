#!/usr/bin/env tsx
// A shipped text field with choices (a bundle's or a module's) says whether a value someone types is remembered as a choice (learns: true or false).
//
// THE BUG THIS PREVENTS. #4516 made every field with choices one picker, and
// a person's new value on it is remembered for the next record, undoably. A
// person's own field learns by default; a shipped one cannot have a default
// that is right for both of its kinds. A vendor or a fibre is an open list
// that should grow (a yarn vendor typed once and never offered again is the
// complaint the issue opened with), while a yarn weight or a status is a
// fixed scale where a remembered typo would sit on everyone's list. Left
// unsaid, a shipped field fell to "does not learn", and nobody had decided.
//
// THE RULE. Every field definition a bundle ships (bundles/*.json, generated
// from web/src/lib/featured-bundles.ts) and every field a module contributes
// (contributes.fieldDefs) that is `type: "text"` with a non-empty `choices`
// carries `learns: true` or `learns: false`. There is no opt-out: the
// declaration IS the decision, and false is always available.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A module's own entity-kind
// field schema (`provides.entityKinds[].fields`, a machine's status, a
// location's kind) is not a field definition anybody edits from a record's
// field list; those are module-owned columns, and choiceLearns already reads
// a module's field as fixed. So the rule reads `contributes.fieldDefs` only,
// by loading each manifest, never by pattern-matching `choices:` in source.
//
// PROVED RED on the bundles as they stood before #4516 (71 fields).
//
//   npx tsx scripts/lint-field-learns-declared.ts   (pnpm lint field-learns-declared)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Violation {
  file: string;
  what: string;
}

interface FieldLike {
  name?: unknown;
  type?: unknown;
  choices?: unknown;
  learns?: unknown;
}

const violations: Violation[] = [];

function needsDecision(f: FieldLike): boolean {
  return (
    typeof f.name === "string" &&
    (f.type ?? "text") === "text" &&
    Array.isArray(f.choices) &&
    f.choices.length > 0 &&
    typeof f.learns !== "boolean"
  );
}

// Bundles: every field definition anywhere in the manifest (top-level
// field_defs, provides_instances, features).
function walk(o: unknown, file: string, path: string) {
  if (Array.isArray(o)) {
    o.forEach((v, i) => walk(v, file, `${path}[${i}]`));
    return;
  }
  if (!o || typeof o !== "object") return;
  const rec = o as Record<string, unknown>;
  if (/field_defs\[\d+\]$/.test(path) && needsDecision(rec)) {
    violations.push({ file, what: `${path} "${String(rec.name)}" has choices but no learns: true | false` });
  }
  for (const [k, v] of Object.entries(rec)) walk(v, file, path ? `${path}.${k}` : k);
}

for (const name of readdirSync("bundles").sort()) {
  if (!name.endsWith(".json") || name === "bundle-versions.lock.json") continue;
  const file = join("bundles", name);
  walk(JSON.parse(readFileSync(file, "utf8")), file, "");
}

// Modules: the fields each one contributes (one entry per field, though a
// module may contribute the same field to several kinds).
const seenModuleField = new Set<string>();
for (const dir of readdirSync("modules").sort()) {
  const file = join("modules", dir, "src", "module.ts");
  if (!existsSync(file)) continue;
  let manifest: { contributes?: { fieldDefs?: FieldLike[] } };
  try {
    manifest = ((await import(pathToFileURL(join(process.cwd(), file)).href)) as { default: typeof manifest }).default;
  } catch (err) {
    // Never a silent skip: a manifest this cannot read is a module it did not check.
    violations.push({ file, what: `could not load the manifest to read its fields: ${(err as Error).message}` });
    continue;
  }
  for (const f of manifest?.contributes?.fieldDefs ?? []) {
    const key = `${file} ${String(f.name)}`;
    if (seenModuleField.has(key)) continue;
    seenModuleField.add(key);
    if (needsDecision(f)) violations.push({ file, what: `contributes.fieldDefs "${String(f.name)}" has choices but no learns: true | false` });
  }
}

if (violations.length) {
  console.error(`lint:field-learns-declared - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}  ${v.what}`);
  console.error(
    "Say whether a value someone types on a record is remembered as a choice: learns: true for an open list (a vendor, a brand, a material), " +
      "learns: false for a fixed scale (a status, a weight class, a size). Bundles: edit web/src/lib/featured-bundles.ts, then npx tsx scripts/sync-bundles.ts.",
  );
  process.exit(1);
}
console.log(`lint:field-learns-declared OK`);
