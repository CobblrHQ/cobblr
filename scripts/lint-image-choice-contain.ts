#!/usr/bin/env tsx
// An image you are being asked to CHOOSE must be shown whole, not cropped.
//
// THE BUG THIS EXISTS FOR (2026-08-15): the catalog-image picker and its
// lightbox filmstrip rendered every candidate with `object-cover`. A square
// crop of a product shot keeps the middle band and throws away the lid and the
// base, so a tall jar became an anonymous stripe of label and fourteen search
// results all looked alike — "mostly cropped and impossible to tell that that
// was indeed the perfect image". The picture was the ONLY thing those tiles
// existed to convey, and it was the part being discarded.
//
// `object-cover` is right for decoration: an avatar, a row icon, a uniform
// browse grid where tidiness beats completeness. It is wrong the moment the
// tile's own label says "use this", "pick", or "make this primary", because
// then the tile IS the decision.
//
// WHY A LINT: nothing about a cropped thumbnail fails a typecheck or a test,
// and it looks fine in a mockup with square fixtures. It only bites on a real
// portrait product shot, in front of a user trying to choose.
//
//   npx tsx scripts/lint-image-choice-contain.ts   (npm run lint:image-choice)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors: string[] = [];

// Surfaces whose whole job is picking one image out of several. These may not
// crop at all — there is no decorative image on them.
const CHOOSING_SURFACES = [
  "web/src/components/ImageSearchPicker.tsx",
  "web/src/components/ImageLightbox.tsx",
];

for (const rel of CHOOSING_SURFACES) {
  let src: string;
  try {
    src = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    errors.push(`${rel} is missing — if it moved, update this lint`);
    continue;
  }
  src.split("\n").forEach((line, i) => {
    if (line.includes("object-cover")) {
      errors.push(
        `${rel}:${i + 1} uses object-cover — every image on this surface is a candidate ` +
          `being compared, so it must be object-contain`,
      );
    }
  });
}

// Forward cover: ANY image cropped inside a control that asks you to choose it.
// The label is the tell — a tile that says "use this image" is the decision.
const CHOOSE_LABEL =
  /(use this image|make this (the )?primary|pick this|choose this|select this image)/i;
const LOOKBACK = 8;

for (const file of sourceFiles("web/src/**/*.tsx")) {
  const rel = relative(ROOT, join(ROOT, file));
  if (CHOOSING_SURFACES.includes(rel)) continue; // already fully covered above
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.includes("object-cover")) return;
    const before = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
    if (!CHOOSE_LABEL.test(before)) return;
    errors.push(
      `${rel}:${i + 1} crops an image inside a control that asks you to choose it ` +
        `("${(before.match(CHOOSE_LABEL) ?? [""])[0]}") — use object-contain so the ` +
        `whole picture is visible`,
    );
  });
}

if (errors.length === 0) {
  console.log("[lint:image-choice] ✓ images you pick between are shown whole");
  process.exit(0);
}
console.error(`\n[lint:image-choice] ✗ ${errors.length} cropped choice image(s):\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nobject-cover is for decoration (avatars, row icons, uniform browse grids).\n` +
    `A tile whose label asks you to USE or PICK it must show the whole image, or the\n` +
    `part you are judging is the part being thrown away.\n`,
);
process.exit(1);
