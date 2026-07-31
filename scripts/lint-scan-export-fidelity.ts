#!/usr/bin/env tsx
// Every field the scan EXPORTER emits must be read by the IMPORTER.
//
// WHY THIS IS A LINT: the exporter carried `x_cobblr` (manufacturer, location
// note, routing candidates, and the metadata blob holding the item's history and
// the user's typed hints) from the day it was written. The importer never looked
// at the field. Nothing failed - not a type, not a test, not a runtime error -
// because a dropped field is indistinguishable from a field that was never sent.
// The loss only became visible when a real 69-item prod export was measured on
// 2026-07-31: 97 history entries, 8 typed hints, 69 candidate sets and 43
// manufacturers crossed the wire and were discarded at the door.
//
// A "lossless carrier for a future importer" is how that started. This check is
// what stops the next field from waiting years for its future.
//
//   npx tsx scripts/lint-scan-export-fidelity.ts   (npm run lint:scan-export-fidelity)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_SVC = join(ROOT, "modules", "core-scan", "src", "services", "export.ts");
const IMPORT_SVC = join(ROOT, "modules", "core-scan", "src", "services", "import.ts");
const IMPORT_API = join(ROOT, "modules", "core-scan", "src", "api", "import.ts");

const exportSrc = readFileSync(EXPORT_SVC, "utf8");
const importSrc = readFileSync(IMPORT_SVC, "utf8") + "\n" + readFileSync(IMPORT_API, "utf8");

/** Field names declared inside a `interface X { ... }` or a nested block. */
function blockKeys(src: string, header: string): string[] {
  const at = src.indexOf(header);
  if (at === -1) return [];
  const open = src.indexOf("{", at);
  if (open === -1) return [];
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end);
  // `name: type;` at any nesting — good enough for these flat shapes, and a
  // false positive only costs an explicit mention in the importer.
  return [...new Set([...body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*[?]?\s*:/gim)].map((m) => m[1]!))];
}

const errors: string[] = [];

/**
 * Is this field actually READ by the importer?
 *
 * Deliberately a property-ACCESS check (`.field`), not a substring search. Half
 * these names are ordinary words — `label`, `origin`, `vendor`, `created_at` —
 * and a bare `includes()` matches them in unrelated code or even in a comment,
 * which is a lint that reports green while the field is dropped. Reading a value
 * off the parsed envelope means dereferencing it.
 */
const isRead = (field: string): boolean =>
  new RegExp(`\\.\\s*${field.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(importSrc);

// The Cobblr-native carrier: every key must be consumed somewhere in the importer.
const xKeys = blockKeys(exportSrc, "  x_cobblr: {");
if (xKeys.length === 0) {
  errors.push("could not read the x_cobblr block from services/export.ts — if it was renamed, update this lint");
}
for (const k of xKeys) {
  if (!isRead(k)) {
    errors.push(`export emits x_cobblr.${k} but the importer never reads it — it would be silently dropped`);
  }
}

// The session block, same rule.
const batchKeys = blockKeys(exportSrc, "export interface ExportBatch {");
if (batchKeys.length === 0) {
  errors.push("could not read ExportBatch from services/export.ts — if it was renamed, update this lint");
}
for (const k of batchKeys) {
  if (!isRead(k)) {
    errors.push(`export emits ExportBatch.${k} but the importer never reads it — sessions would arrive incomplete`);
  }
}

// The envelope's batches block must be parsed at all.
if (exportSrc.includes("x_cobblr_batches") && !importSrc.includes("x_cobblr_batches")) {
  errors.push("the envelope carries x_cobblr_batches but the importer never parses it — sessions would be lost");
}

if (errors.length === 0) {
  console.log(
    `[lint:scan-export-fidelity] ✓ every exported field is consumed on import ` +
      `(${xKeys.length} x_cobblr, ${batchKeys.length} session fields).`,
  );
  process.exit(0);
}
console.error(`\n[lint:scan-export-fidelity] ✗ ${errors.length} field(s) would be lost on a Cobblr→Cobblr move:\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nAn export that emits a field the importer ignores loses data with no error and no warning.\n` +
    `Either consume it in ${relative(ROOT, IMPORT_SVC)} / ${relative(ROOT, IMPORT_API)}, or stop emitting it.\n`,
);
process.exit(1);
