#!/usr/bin/env tsx
// A record photo field offers the shared picker through RecordPhoto or WebPhotoSearch.
//
// THE BUG THIS PREVENTS. Parts offered a cover and gallery without clipboard links or web photo search.
//
// Record editors that mutate image_path or offer a cover gallery compose the
// shared photo block. Gallery internals and create forms that seed a catalog
// image do different work: neither is the record's photo field.
// Proven red on the part detail page before its shared block was added.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/source-scan.js";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src/pages", "modules"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx")) return [];
  src = stripComments(src);
  const photoField = /<(?:EntityImageEdit|PartGallery)\b|\b(?:update|patch)\w*\.mutate\s*\(\s*\{[^}]*\bimage_path\s*:/s.exec(src)
    ?? (/(?:Detail[^/]*|AssetsPage|MachinesPage|RecordsPage)\.tsx$/.test(file) ? /src=\{[^}]*\.image_path/s.exec(src) : null);
  if (!photoField || /<(?:RecordPhoto|WebPhotoSearch)\b/.test(src)) return [];
  return [{ file, line: src.slice(0, photoField.index).split("\n").length,
    what: "record photo field without the shared web/link picker" }];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:photo-field-has-web-picker - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Compose RecordPhoto or WebPhotoSearch beside the record photo field.");
    process.exit(1);
  }
  console.log(`lint:photo-field-has-web-picker OK`);

}
