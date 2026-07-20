// Guard: every column of inventory_parts must be listed in PART_FILTER_COLS.
//
// The parts list resolver has two filter dialects. A key in PART_FILTER_COLS
// compiles to `where col = value`; ANY OTHER key compiles to
// `metadata ->> key = value`, which is correct for a custom field.
//
// The trap is that those two are indistinguishable at the type level, and the
// wrong one does not throw. `metadata ->> 'serial_number'` is null for every row
// (the value lives in its own column), so the filter matches nothing and the
// caller reports "no such entity" rather than "bad filter". A scan rule
// resolving a lasered serial number therefore reported every part as missing,
// silently, from the day the column shipped in migration 0004.
//
// So: adding a column to the table without adding it here re-creates a silent
// wrong answer. This makes it a build failure instead.
// Run: npx tsx scripts/lint-part-filter-cols.ts

import { readFileSync } from "node:fs";

const DB = "modules/inventory/src/db.ts";

// `metadata` is the CONTAINER for the other dialect, so it is the one column
// that legitimately must not be a native filter key.
const EXCLUDED = new Map([["metadata", "it is the container the D8 dialect reads through"]]);

const src = readFileSync(DB, "utf8");

const iface = /export interface InventoryPartsTable \{([\s\S]*?)\n\}/.exec(src);
if (!iface) {
  console.error(`part-filter-cols lint: could not find InventoryPartsTable in ${DB}.`);
  console.error(`If the table was renamed or moved, update this lint rather than deleting it.`);
  process.exit(1);
}
const columns = [...iface[1]!.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]!);

const setBlock = /export const PART_FILTER_COLS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
if (!setBlock) {
  console.error(`part-filter-cols lint: could not find PART_FILTER_COLS in ${DB}.`);
  process.exit(1);
}
const listed = new Set([...setBlock[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

const missing = columns.filter((c) => !listed.has(c) && !EXCLUDED.has(c));
const stale = [...listed].filter((c) => !columns.includes(c));

if (missing.length || stale.length) {
  console.error(`part-filter-cols lint: PART_FILTER_COLS does not match the table.\n`);
  if (missing.length) {
    console.error(`  Columns MISSING from the set. A filter on these compiles to`);
    console.error(`  \`metadata ->> col\`, which is null for every row, so it matches nothing`);
    console.error(`  and reports the entity as absent instead of erroring:`);
    for (const c of missing) console.error(`    ❌ ${c}`);
  }
  if (stale.length) {
    console.error(`  Listed but NOT a column (typo, or the column was dropped). These build`);
    console.error(`  a \`where <col> = ...\` against something that does not exist:`);
    for (const c of stale) console.error(`    ❌ ${c}`);
  }
  console.error(`\n  Fix ${DB}. Every column belongs in PART_FILTER_COLS except:`);
  for (const [c, why] of EXCLUDED) console.error(`    ${c} — ${why}`);
  process.exit(1);
}

console.log(
  `part-filter-cols lint: all ${columns.length - EXCLUDED.size} filterable columns listed ✓`,
);
