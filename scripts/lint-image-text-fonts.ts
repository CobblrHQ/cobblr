#!/usr/bin/env tsx
// If we burn TEXT into an image, the runtime image must have a font.
//
// WHY THIS IS A LINT: sharp renders SVG <text> through librsvg/fontconfig, and
// node:22-alpine ships NO fonts. Without them the text renders BLANK - no error,
// no warning, just an empty box where the label should be. The scan inbox's AI
// photo picker composes a NUMBERED contact sheet and asks the model for a tile
// number, so unlabelled tiles mean the model is guessing at its own answer.
//
// It was caught only by rendering a test glyph inside the deployed container
// (2026-07-30). Nothing in the repo would notice a base-image bump, or someone
// tidying the apk line, silently reverting it. A blank label is invisible in
// code review and in CI, which is exactly what a check is for.
//
//   npx tsx scripts/lint-image-text-fonts.ts    (npm run lint:image-text-fonts)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Sources that draw text into an image.
const renderers: string[] = [];
function walk(dir: string): void {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
      const s = readFileSync(p, "utf8");
      if (/<text[\s>]/.test(s) && /sharp/.test(s)) renderers.push(relative(ROOT, p));
    }
  }
}
for (const d of ["modules", "api/src", "packages"]) {
  try { walk(join(ROOT, d)); } catch { /* absent */ }
}

if (renderers.length === 0) {
  console.log("[lint:image-text-fonts] ✓ nothing burns text into an image.");
  process.exit(0);
}

const dockerfile = join(ROOT, "docker", "api.Dockerfile");
const df = readFileSync(dockerfile, "utf8");
// The RUNTIME stage is what serves requests; a font in the builder is useless.
const runtime = df.slice(df.lastIndexOf("FROM "));
const hasFont = /ttf-dejavu|font-noto|fonts-dejavu|ttf-liberation|fonts-liberation/.test(runtime);
const hasFontconfig = /fontconfig/.test(runtime);

if (hasFont && hasFontconfig) {
  console.log(
    `[lint:image-text-fonts] ✓ ${renderers.length} renderer(s) burn text, and the api runtime image installs fonts + fontconfig.`,
  );
  process.exit(0);
}
console.error(
  `\n[lint:image-text-fonts] ✗ these render TEXT into an image:\n` +
    renderers.map((r) => `    ${r}`).join("\n") +
    `\n\n  ...but docker/api.Dockerfile's RUNTIME stage is missing ${
      !hasFont ? "a font package" : ""
    }${!hasFont && !hasFontconfig ? " and " : ""}${!hasFontconfig ? "fontconfig" : ""}.\n` +
    `  sharp renders SVG <text> via librsvg/fontconfig; with no font it renders BLANK -\n` +
    `  silently, with no error. Add to the runtime stage:\n\n` +
    `      RUN apk add --no-cache fontconfig ttf-dejavu && fc-cache -f\n`,
);
process.exit(1);
