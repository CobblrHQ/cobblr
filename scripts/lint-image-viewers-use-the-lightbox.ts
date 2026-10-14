#!/usr/bin/env tsx
// A picture that opens bigger opens in the shared Lightbox (@cobblr/platform-web), never in its own overlay, a modal holding an image, or a new tab.
//
// THE BUG THIS PREVENTS. #4319: a report's three screenshots opened one at a time in a plain modal; 10 of 13 image viewers were their own
//
// THE RULE. A picture that opens bigger opens in the ONE viewer, so stepping
// through a set (← →, the side buttons, a swipe, "2 of 5", Esc, focus back
// on the thumbnail) works the same everywhere. Four shapes of a home-made
// viewer fail:
//   1. a link that opens a picture in a new tab: an <a target="_blank"> whose
//      content is an <img>, EntityPhoto or EntityThumb;
//   2 and 3. a picture sized to fill a full-screen layer or a dialog of its
//      own: in a file that renders an <OverlayLayer> or a <Modal>, an <img>
//      or EntityPhoto whose size is max-h-full, max-h-screen, h-screen or
//      max-h-[NNvh];
//   4. a component named like a viewer (…Lightbox, …ImageViewer,
//      …PhotoViewer, …ImageZoom) outside the shared one and web's wrapper.
// A picture that is not a viewer says why, on the line or within the three
// above: `// lightbox-exempt: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first cut flagged any
// layer or dialog holding a picture, and caught nine: a printer's cockpit
// with its camera frame, a catalog row's detail, the Quick Access panel,
// the app player's logo, a phone sheet's thumbnail. Each is a panel with a
// picture IN it; a viewer's picture is sized to fill the layer. That size
// is the line. The camera and the crop tool do fill the screen with a
// picture and are still tools, not viewers: they say so with the marker. A picture beside its own link to an external page (a web
// candidate's source) is not shape 1 either: the anchor wraps text there,
// not the image.
//
//   npx tsx scripts/lint-image-viewers-use-the-lightbox.ts   (pnpm lint image-viewers-use-the-lightbox)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules", "ops-console/src"];

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

const SHARED = new Set(["packages/platform-web/src/Lightbox.tsx", "web/src/components/ImageLightbox.tsx"]);
const PICTURE = /<(img\b|EntityPhoto\b|EntityThumb\b)/;
const EXEMPT = /lightbox-exempt:\s*\S/;
/** A size that fills the screen or the box it is in: a viewer's picture. */
const FILLS = /\bmax-h-(?:full|screen|\[\d+d?vh\])|\bh-screen\b/;

/** The text of one JSX opening tag, from `<` to its closing `>` at brace
 *  depth 0 (an arrow function in an attribute holds a `>` of its own). */
function tagText(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length && i < at + 4000; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at, at + 4000);
}

/** Exempt when the marker is on the line or within the three above it. */
function exempt(lines: string[], i: number): boolean {
  for (let k = Math.max(0, i - 3); k <= i; k++) if (EXEMPT.test(lines[k] ?? "")) return true;
  return false;
}
const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (SHARED.has(file) || !/\.tsx$/.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const flag = (at: number, what: string) => {
    const line = lineOf(src, at);
    if (!exempt(lines, line - 1)) out.push({ file, line, what });
  };

  // 1. A new tab to a picture.
  for (const m of src.matchAll(/<a\b[^>]*target=["{]["']?_blank["']?}?[^>]*>([\s\S]*?)<\/a>/g)) {
    if (PICTURE.test(m[1]!)) flag(m.index!, "a picture that opens in a new tab");
  }

  // 2 and 3. A picture sized to fill the layer or the dialog it sits in: that
  // is what makes it a viewer, where a thumbnail in a panel is not one.
  if (/<(OverlayLayer|Modal)\b/.test(src)) {
    for (const m of src.matchAll(/<(img|EntityPhoto)\b/g)) {
      const tag = tagText(src, m.index!);
      if (FILLS.test(tag)) flag(m.index!, "a picture sized to fill a layer or dialog of its own");
    }
  }

  // 4. A viewer by name.
  for (const m of src.matchAll(/\bfunction\s+(\w*(?:Lightbox|ImageViewer|PhotoViewer|ImageZoom)\w*)\s*\(/g)) {
    flag(m.index!, `a viewer of its own (${m[1]})`);
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:image-viewers-use-the-lightbox - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Render <Lightbox items index onIndex onClose> (or web's ImageLightbox for workspace files); a picture that is not a viewer says so: // lightbox-exempt: <why>");
  process.exit(1);
}
console.log(`lint:image-viewers-use-the-lightbox OK`);
