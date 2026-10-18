#!/usr/bin/env tsx
// A section that lists a record's photos from the core-files attachments list builds them with recordPhotos, so the record's cover leads even when it was never attached.
//
// THE BUG THIS PREVENTS. #7335 (2026-10-18): a Lego set's Photos panel said No photos yet above the set's own photo in Photos and files; the photo was the set's cover, never attached, and the panel read only the attachments.
//
// THE RULE. A file that asks core-files for one record's attachments
// (`/attachments?source_module=`) and picks the pictures out of them
// (`kind === "image"`, `kind !== "image"`, a mime `startsWith("image/")`)
// calls recordPhotos from @cobblr/platform-contract/record-photos. The list
// answers `main` (the record's cover, read off the record) beside `items`
// (what is attached); recordPhotos leads with the cover whether or not it is
// attached. A file that picks pictures for another reason says
// `// record-photos: <why>` on that line.
//
// THE BOUNDARY. A file that reads the attachments list only for its files
// (a receipt, a pattern PDF) and never picks out pictures is not judged:
// projects' api.ts reads it for the pattern. Tests are not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-photo-section-leads-with-the-records-cover.ts   (pnpm lint a-photo-section-leads-with-the-records-cover)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!src.includes("/attachments?source_module=")) return out;
  if (/\brecordPhotos\(/.test(src)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/kind\s*[!=]==\s*"image"|startsWith\("image\/"\)/.test(line)) continue;
    if (/\/\/ record-photos: \S/.test(line)) continue;
    out.push({ file, line: i + 1, what: "picks a record's pictures out of its attachments without recordPhotos: a cover that was never attached goes missing and the section says it has no photos" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-photo-section-leads-with-the-records-cover - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("build the strip with recordPhotos(list) from @cobblr/platform-contract/record-photos, or say // record-photos: <why> on the line that filters the images");
  process.exit(1);
}
console.log(`lint:a-photo-section-leads-with-the-records-cover OK`);
