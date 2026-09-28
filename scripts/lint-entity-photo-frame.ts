#!/usr/bin/env tsx
// An entity's photo renders in EntityPhoto: a file that resolves a photo
// (useImageSrc) and draws its own <img> is refused, so a photo can never size
// the tile it sits in.
//
// THE BUG THIS PREVENTS. The vending wall on a groceries shelf (2026-09-27):
// each slot asked for a 4:3 box and put its own <img> at height 100% inside
// it. An aspect-ratio box keeps `min-height: auto`, so a tall photo still
// pushed its natural height through: a bag of celery made its row ~800px
// beside a short tile for eggs, leaving dark blocks down the wall. Thirty-odd
// places drew an entity photo their own way (cards, list thumbnails, gallery
// tiles, the scan strips), each one free to meet that again. EntityPhoto
// (packages/platform-web) gives the box its size first and lays the picture
// out absolutely inside it.
//
// THE RULE. In the web shell, module UIs and platform-web, a file that calls
// useImageSrc( and also writes a raw <img element fails, one violation per
// <img. EntityPhoto.tsx itself is the one place that may. A picture that is
// genuinely not a framed photo (a full-size lightbox, a receipt document, a
// crop tool, a screenshot) opts out with a comment on the <img line or the four
// lines above it: `photo-frame: <why this is not a framed photo>`. The reason
// is required; a bare `photo-frame:` is itself a violation.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A file that renders an
// <img of something that is not resolved through useImageSrc (the app's own
// icon, an SVG data URL, a QR code) is not judged: the rule keys on the
// resolve, because that is what an entity's stored photo goes through. Tests
// are not judged.
//
// PROVE IT RED before you trust it green: it failed on ViewsPage.tsx's vending
// tile and gallery tile before the move.
//
//   npx tsx scripts/lint-entity-photo-frame.ts   (pnpm lint entity-photo-frame)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
/** Where a module's UI lives; its api and migrations are not judged. */
const inScope = (file: string) => !file.startsWith("modules/") || /\/src\/ui\//.test(file) || /\/ui\//.test(file);
const OWNER = "packages/platform-web/src/EntityPhoto.tsx";

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) yield p;
  }
}

export function check(file: string, src: string): Violation[] {
  if (file === OWNER || !/\buseImageSrc\(/.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/<img\b/.test(line)) continue;
    // A comment that mentions <img is prose, not an element.
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || /\/\/.*<img\b/.test(line)) continue;
    const near = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
    const note = /photo-frame:\s*(.*)/.exec(near);
    if (note && note[1]!.replace(/\*\/\s*\}?\s*$/, "").trim().length >= 8) continue;
    out.push({
      file,
      line: i + 1,
      what: note ? "a photo-frame: annotation with no reason" : "a raw <img> of a resolved photo; render it in <EntityPhoto> from @cobblr/platform-web",
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (inScope(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:entity-photo-frame - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "An entity's photo sits in EntityPhoto, which sizes the box before the picture arrives,\n" +
      "so a tall photo cannot stretch its tile. A picture that is not a framed photo (a lightbox,\n" +
      "a receipt, a crop tool) says so: `photo-frame: <why>` on the <img line or just above it.",
  );
  process.exit(1);
}
console.log("lint:entity-photo-frame OK");
