// Guard: "search the web for an image" is ONE component, everywhere.
//
// The class this kills: image search kept getting re-implemented per page, and
// each copy drifted. The scan inbox grew a full-screen viewer and a phrase built
// from the item's own fields; the record page got a bare grid, a blank search
// box and a bare-title query. Same feature, three behaviours, and the user hit
// the worst one on the page where it mattered (reported 2026-07-18: "this needs to
// be a global platform standard").
//
// Mechanically: only ImageSearchPicker.tsx may call the image-options endpoint.
// Any other page that wants web image search composes the picker instead — so a
// fix to the phrase, the viewer or the tiles lands on every surface at once.
//
// Run: npx tsx scripts/lint-image-search-single-surface.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];
const OWNER = "web/src/components/ImageSearchPicker.tsx";
// The call that fetches web image candidates. A page reaching for this directly
// is a page about to grow its own copy of the UI around it.
const FORBIDDEN = /\bapi\.imageOptions\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let ownerFound = false;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    if (file === OWNER) {
      ownerFound = true;
      continue;
    }
    if (FORBIDDEN.test(readFileSync(file, "utf8"))) {
      failures.push(file);
    }
  }
}

// A renamed/moved owner would silently disarm the whole check.
if (!ownerFound) {
  console.error(`✗ lint-image-search-single-surface: owner ${OWNER} not found — update this lint`);
  process.exit(1);
}

if (failures.length) {
  console.error("✗ lint-image-search-single-surface: image search must go through ImageSearchPicker:");
  for (const f of failures) {
    console.error(`  ${f}: calls api.imageOptions directly — render <ImageSearchPicker> instead`);
  }
  console.error(
    "  (the picker owns the derived phrase, the pre-filled term and the full-screen viewer;\n" +
      "   a second call site is how those three drifted apart last time)",
  );
  process.exit(1);
}

console.log("✓ image-search lint: api.imageOptions is called only by ImageSearchPicker");
process.exit(0);
