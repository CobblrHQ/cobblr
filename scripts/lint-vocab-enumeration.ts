// Code that is supposed to be GENERIC over a closed vocabulary, enumerating it.
//
// There are two ways to hardcode a mapping and only the first is obvious:
//
//   1. Match on a NAME. `fields.find(f => f.name === "acquired_from")` works in
//      exactly the workspace that inspired it. Loud, and usually caught.
//   2. Enumerate the CONCEPTS. One branch per vocabulary member, or a
//      hand-written type with one property per member. Adding a member then
//      edits the "generic" code. QUIET, because the names around it look
//      generic and the thing reviews clean.
//
// (2) shipped on 2026-08-12: a role matcher with four `firstWithRole(fields,
// "<role>")` calls and a four-property input interface. Nothing was wrong with
// the field names, which is exactly why it looked finished. It reached a green
// CI and was caught by a human asking "is this actually generic?".
//
// So: a file that names three or more members of a closed vocabulary is either
// declaring data about them (fine, say so) or enumerating them (usually a bug).
//
// LIMITS, stated so nobody trusts this further than it goes:
//   - It cannot see a hand-written type whose PROPERTY names differ from the
//     vocabulary values. `{ vendor, seller, purchasedOn }` mirrors three roles
//     and matches no literal. The type-level fix is to derive the shape
//     (`Partial<Record<FieldRole, T>>`), which this cannot enforce.
//   - A file legitimately exempt (the vocabulary's own module) can then hide a
//     real enumeration added later.
//
// The durable guard is a TEST that carries a vocabulary member the code has
// never heard of through the generic path. This lint is the cheap early net,
// not the guarantee.
//
// Opt out where enumeration is the point, with a reason on the same line or the
// line above:  // VOCAB-ENUMERATION OK: <why>
//
// Run: npx tsx scripts/lint-vocab-enumeration.ts

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CONTRACT = "packages/platform-contract/src/index.ts";

/** Closed vocabularies worth guarding, read from their single definition so this
 *  lint cannot drift from the enum it protects.
 *
 *  ROLES only, and the omission of TYPES is the interesting part. Running this
 *  over FIELD_TYPE_VALUES produced 35 offenders and every one was correct: a
 *  renderer, an input control and a filter builder all genuinely have to tell a
 *  date from a number. That is the job, not a shortcut.
 *
 *  The distinction is what the vocabulary DECIDES:
 *    a TYPE decides how a value is stored, drawn and edited  -> code must branch
 *    a ROLE decides what a value MEANS                       -> code must look up
 *
 *  So a `switch (field.type)` is healthy and a `switch (field.field_role)` is
 *  almost always something that should have been a lookup. Adding a vocabulary
 *  here is only worth it when it is role-shaped by that test. */
const VOCABS = [{ name: "FIELD_ROLE_VALUES", const: "FIELD_ROLE_VALUES" }];

/** Three is the threshold: two literals is a pair being compared, three starts
 *  to be a list someone is walking. */
const THRESHOLD = 3;

const ALLOW = /VOCAB-ENUMERATION OK:/;

function valuesOf(constName: string): string[] {
  const src = readFileSync(CONTRACT, "utf8");
  const m = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(src);
  if (!m) {
    console.error(`vocab-enumeration lint: cannot find ${constName} in ${CONTRACT}.`);
    process.exit(1);
  }
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

const files = execSync("git ls-files api/src web/src modules packages", { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f))
  // Tests SHOULD enumerate: carrying several members through one call is the
  // very thing that proves the code under test is generic.
  .filter((f) => !/\.test\.tsx?$/.test(f));

const failures: string[] = [];

for (const vocab of VOCABS) {
  const values = valuesOf(vocab.const);
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // The vocabulary's own module defines and documents it.
    if (file === CONTRACT) continue;

    const lines = src.split("\n");
    const seen = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (ALLOW.test(line) || ALLOW.test(lines[i - 1] ?? "")) continue;
      for (const v of values) {
        if (line.includes(`"${v}"`) && !seen.has(v)) seen.set(v, i + 1);
      }
    }
    if (seen.size < THRESHOLD) continue;
    if (ALLOW.test(src.split("\n").slice(0, 40).join("\n"))) continue;

    const where = [...seen.entries()].map(([v, ln]) => `${v} (line ${ln})`).join(", ");
    failures.push(
      `${file}: names ${seen.size} members of ${vocab.name} — ${where}\n` +
        `      If this is generic code, it should not know them: drive it from the ` +
        `vocabulary (a Record<${vocab.name.replace("_VALUES", "")}, …> or a declared table) ` +
        `so adding a member changes nothing here.\n` +
        `      If enumerating IS the point (declaring data about each, rendering a ` +
        `label per member), say so: // VOCAB-ENUMERATION OK: <why>`,
    );
  }
}

if (failures.length) {
  console.error("✗ lint-vocab-enumeration: generic code enumerating a closed vocabulary:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ vocab-enumeration lint: ${files.length} files, no un-declared enumeration of ${VOCABS.length} vocabularies`,
);
process.exit(0);
