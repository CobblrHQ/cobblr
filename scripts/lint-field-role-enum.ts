// Guard: the field-role enum has ONE definition, FieldRoleSchema in the contract.
//
// The set of field roles (category, pack, identifier) was hand-written as a zod
// enum in three places: the manifest's EntityField schema and both bundle-field
// routes. Adding a role (identifier) meant editing all three, and a missed one
// is a SILENT gap: a bundle author sets field_role: "identifier", the route that
// still lists only [category, pack] rejects it as a bad request, and the field
// quietly never becomes an identifier. Valid code, passing tests, wrong answer.
//
// So there is one FieldRoleSchema and everyone imports it. This fails on a
// hand-rolled field-role enum literal anywhere else.
// Run: npx tsx scripts/lint-field-role-enum.ts

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const CONTRACT = "packages/platform-contract/src/index.ts";

// A zod enum literal that lists the field-role values by hand. Matches
// z.enum(["category", "pack"]) / z.enum(["category","pack","identifier"]) etc.,
// in any order, so a drifted copy is caught however it was written.
const HANDROLLED = /z\.enum\(\[\s*("(?:category|pack|identifier)"\s*,?\s*){2,}\]\)/;

const files = [
  ...globSync("api/src/**/*.ts"),
  ...globSync("web/src/**/*.{ts,tsx}"),
  ...globSync("modules/*/src/**/*.{ts,tsx}"),
  ...globSync("packages/*/src/**/*.ts"),
].filter((f) => f !== CONTRACT);

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    if (HANDROLLED.test(line)) offenders.push({ file, line: i + 1, text: line.trim().slice(0, 100) });
  });
}

if (offenders.length > 0) {
  console.error(`field-role-enum lint: a field-role enum is hand-rolled outside ${CONTRACT}.\n`);
  for (const o of offenders) console.error(`    ❌ ${o.file}:${o.line}\n       ${o.text}`);
  console.error(
    `\n  Import the one definition instead:` +
      `\n    import { FieldRoleSchema } from "@cobblr/platform-contract";` +
      `\n    field_role: FieldRoleSchema.optional(),` +
      `\n\n  A hand-rolled copy that misses a role rejects that role at a request boundary,` +
      `\n  silently, while the manifest happily declares it.`,
  );
  process.exit(1);
}

// The canonical definition must actually exist and carry the shared const, so a
// future rename can't leave this lint guarding nothing.
const contract = readFileSync(CONTRACT, "utf8");
if (!/export const FIELD_ROLE_VALUES = \[/.test(contract) || !/export const FieldRoleSchema = z\.enum\(FIELD_ROLE_VALUES\)/.test(contract)) {
  console.error(`field-role-enum lint: FIELD_ROLE_VALUES / FieldRoleSchema not found in ${CONTRACT}.`);
  console.error(`  If they were renamed, update this lint (and every importer) rather than deleting it.`);
  process.exit(1);
}

console.log(`field-role-enum lint: ${files.length} files, one FieldRoleSchema ✓`);
