#!/usr/bin/env tsx
// A row's pictures are listed by the one resolver (lib/rowPictures.ts over the contract's scan-pictures): no display read of extra_photos, image_file_id, screenshot_crop_file_id or group_image_file_id builds a picture URL elsewhere in web/src
//
// THE BUG THIS PREVENTS. The strip's "Your photos" column was empty for two
// split children on the desk (#3046, 2026-09-15): the column listed
// extra_photos alone, the pair read image_file_id, the lightbox read its own
// subset, and a split child's group shot lived on the parent where nobody
// read it. "Which pictures does this row have" was computed four ways, so
// the pictures a person most wanted to re-crop from were offered nowhere.
//
// THE RULE. One resolver lists a row's pictures: the contract's
// scan-pictures.ts (roles, order, the current one), wrapped for addresses by
// web/src/lib/rowPictures.ts. So in web/src, outside that wrapper, a
// .tsx/.ts file may not read `extra_photos`, `screenshot_crop_file_id` or
// `group_image_file_id` at all, and may not build a picture URL from
// `image_file_id` (`files/${x.image_file_id}`, `fileUrl(x.image_file_id)`,
// `image_file_id}/raw`). A truthiness check on image_file_id ("does this row
// have a photo") is fine; listing or showing it is the resolver's job. Tests
// are exempt. No opt-out: a surface that needs a picture asks the resolver.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified. Red first on the pair, the strip,
// the result sheet and the capture drawer of main at b4e655997
// (COBBLR_LINT_ROOT=<a checkout> points it at another tree).
//
//   npx tsx scripts/lint-row-pictures-resolved.ts   (pnpm run lint:row-pictures-resolved)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src"].map((r) => join(BASE, r));
const THE_RESOLVER = /web\/src\/lib\/rowPictures\.ts$/;
const KEYS = /\b(extra_photos|screenshot_crop_file_id|group_image_file_id)\b/;
const URL_FROM_OWN = /files\/\$\{[^}]*(?<![a-z_])image_file_id[^}]*\}|fileUrl\([^)]*(?<![a-z_])image_file_id[^)]*\)|(?<![a-z_])image_file_id\)?\}\/raw/;
/** The catalog picture's address too: one helper (scanFileUrl), not a
 *  template on every surface. */
const URL_FROM_CATALOG = /files\/\$\{[^}]*catalog_image_file_id[^}]*\}|catalog_image_file_id\)?\}\/raw/;

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
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (THE_RESOLVER.test(file) || /web\/src\/lib\/api\.ts$/.test(file)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
    const key = line.match(KEYS)?.[1];
    if (key) out.push({ file, line: i + 1, what: `reads ${key}; the row's pictures come from lib/rowPictures.ts` });
    if (URL_FROM_OWN.test(line)) out.push({ file, line: i + 1, what: "builds a picture URL from image_file_id; ask lib/rowPictures.ts (leadYours / yourPictures + src)" });
    else if (URL_FROM_CATALOG.test(line)) out.push({ file, line: i + 1, what: "builds the catalog picture's URL inline; use scanFileUrl from lib/rowPictures.ts" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:row-pictures-resolved - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:row-pictures-resolved OK`);
