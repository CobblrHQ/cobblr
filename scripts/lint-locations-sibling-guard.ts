// Every door into core_locations_locations has to have an opinion about a
// duplicate sibling name.
//
// The bug this exists to prevent: an assistant was asked to give each rack
// "Shelf 1..5" in a room where one rack already had a Shelf 1 and a Shelf 2.
// Sixty creates went through unchecked and the rack ended up with two of each,
// reported as "all done". The rule now lives under the writers (siblings.ts) —
// but only under the two that were wired up, and the next insert path added
// will be written by someone who never saw this happen.
//
// So: a file that inserts into the table either calls the check, or says in a
// SIBLING-DUP-OK: marker why a duplicate is fine there. Both are fine answers.
// Not having thought about it is not.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "modules/core-locations/src/api";
const INSERT = /insertInto\(\s*["'`]core_locations_locations["'`]\s*\)/;
const CHECKED = /siblingNamed\s*\(/;
const MARKER = /SIBLING-DUP-OK:\s*\S+/;

const offenders: string[] = [];
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(DIR, f), "utf8");
  if (!INSERT.test(src)) continue;
  if (CHECKED.test(src) || MARKER.test(src)) continue;
  offenders.push(`${DIR}/${f}`);
}

if (offenders.length) {
  console.error("[lint:locations-sibling-guard] inserts a location without deciding about duplicate names:");
  for (const f of offenders) console.error(`  - ${f}`);
  console.error(
    "\n  Call siblingNamed() before inserting (see api/siblings.ts), or add a\n" +
      "  `SIBLING-DUP-OK: <why>` comment if duplicates are correct on this path.",
  );
  process.exit(1);
}
console.log("[lint:locations-sibling-guard] ✓ every location insert has an opinion about duplicate names");
