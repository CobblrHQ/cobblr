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
// AND EVERY PICTURE THE ROW SHOWS. The pictures a row draws are what the
// contract's resolver lists (packages/platform-contract/src/scan-pictures.ts:
// its own photo, a split child's group shot, the screenshot crop, the gallery,
// the catalog picture). The export carried the first and the last; the rest
// crossed only as the SOURCE's file ids in the metadata blob, which on the
// destination point at nothing (#3127, 2026-09-20: every split child in a
// moved workspace lost its group shot). So every key the resolver reads off a
// row or its metadata must be named by the exporter (it carries the file) AND
// by the importer (it stores the file and rewrites the id): a picture the
// resolver learns to draw is one the move must learn to carry, or this is red.
//
// PROVE IT RED: COBBLR_LINT_ROOT=<a checkout at or before f8b200d63> points it
// at another tree; there it reports four losses (the exporter not asking the
// resolver, and group_image_file_id, screenshot_crop_file_id and extra_photos
// unnamed by the importer).
//
//   npx tsx scripts/lint-scan-export-fidelity.ts   (pnpm run lint scan-export-fidelity)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_SVC = join(ROOT, "modules", "core-scan", "src", "services", "export.ts");
const IMPORT_SVC = join(ROOT, "modules", "core-scan", "src", "services", "import.ts");
const IMPORT_API = join(ROOT, "modules", "core-scan", "src", "api", "import.ts");

const PICTURES = join(ROOT, "packages", "platform-contract", "src", "scan-pictures.ts");

const exportSrc = readFileSync(EXPORT_SVC, "utf8");
const importSrc = readFileSync(IMPORT_SVC, "utf8") + "\n" + readFileSync(IMPORT_API, "utf8");
const picturesSrc = readFileSync(PICTURES, "utf8");

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

// Every picture key the resolver reads: the PictureRow columns and the
// metadata keys rowPictures dereferences (`meta.<key>`), less the ones that
// are not pictures (split_from names the parent, not a file; catalog_source
// says where the catalog picture came from, a word the importer carries with
// the rest of the metadata, #6100).
const NOT_A_PICTURE = new Set(["split_from", "suggested_metadata", "catalog_source"]);
const pictureKeys = [
  ...blockKeys(picturesSrc, "export interface PictureRow {"),
  ...[...picturesSrc.matchAll(/\bmeta\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]!),
].filter((k, i, all) => !NOT_A_PICTURE.has(k) && all.indexOf(k) === i);
if (pictureKeys.length < 4) {
  errors.push("could not read the picture keys from scan-pictures.ts (PictureRow + meta.<key>) — if it was reshaped, update this lint");
}
// The exporter asks the resolver, so it carries every picture by construction
// (and reads no key itself, which is lint:row-pictures-resolved's rule); the
// importer writes each key back, so it must name each one.
const named = (src: string, key: string): boolean => new RegExp(`\\b${key}\\b`).test(src);
if (!/\browPictures\(/.test(exportSrc)) {
  errors.push("the exporter does not ask the pictures resolver (rowPictures) — a picture the resolver draws is one the export would not carry");
}
for (const k of pictureKeys) {
  if (!named(importSrc, k)) errors.push(`the row shows a picture read from \`${k}\` but the importer never names it — the source's file id would arrive, pointing at nothing`);
}

// The envelope's batches block must be parsed at all.
if (exportSrc.includes("x_cobblr_batches") && !importSrc.includes("x_cobblr_batches")) {
  errors.push("the envelope carries x_cobblr_batches but the importer never parses it — sessions would be lost");
}

if (errors.length === 0) {
  console.log(
    `[lint:scan-export-fidelity] ✓ every exported field is consumed on import ` +
      `(${xKeys.length} x_cobblr, ${batchKeys.length} session fields), and every picture the row shows is carried (${pictureKeys.length} keys).`,
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
