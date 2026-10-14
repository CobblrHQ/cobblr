#!/usr/bin/env tsx
// A record page shows its photo, a suggestion and the web search through RecordPhoto, and a picture picked from the web is kept only through usePictureFromWeb.
//
// THE BUG THIS PREVENTS. The same suggested photo sat in three hand-built blocks; on one the picked suggestion never reached the photo box and a pick that showed fine said only Couldn't save (#4373, 2026-10-01)
//
// THE RULE. On a record's own page, the photo box, the suggested photo and
// "Find a photo on the web" are one block, RecordPhoto. So:
//   • <EntityImageEdit> appears only inside RecordPhoto.tsx;
//   • <SuggestedPhoto> appears only in the universal record panel, for pages
//     with no photo box of their own;
//   • a file that keeps a picked web picture (enrichEntityImage with an
//     image_url) is RecordPhoto.tsx, whose usePictureFromWeb sends the copy
//     the person saw and shows the server's reason when none was kept.
// Each copy that lived on a page drifted: the machine page showed a picked
// suggestion as a small tile under an empty box, and a hand-written pick
// said only "Couldn't save that image." when the site refused its original.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The scan inbox keeps its
// catalog picture through its own route (catalog-image), which already falls
// back to the thumbnail, and composes ImageSearchPicker directly; it is not a
// record page, so it is outside this rule. A comment or a test naming a
// component is not a use: only JSX and the call count.
//
//   npx tsx scripts/lint-record-photo-one-block.ts   (pnpm lint record-photo-one-block)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules"];

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
const OWNERS: Record<string, { pattern: RegExp; home: string; what: string }> = {
  photoBox: { pattern: /<EntityImageEdit\b/, home: "web/src/components/RecordPhoto.tsx", what: "<EntityImageEdit> outside RecordPhoto: compose <RecordPhoto>" },
  panel: { pattern: /<SuggestedPhoto\b/, home: "web/src/features/core-scan/suggestedPhoto.tsx", what: "<SuggestedPhoto> on a page: the page's photo box shows the suggestion through <RecordPhoto>" },
};
const KEEPER = "web/src/components/RecordPhoto.tsx";

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // The web client's call, not the api route that answers it.
  const keepsWebPicks = /\bapi\.enrichEntityImage\s*\(/.test(src);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const o of Object.values(OWNERS)) {
      if (file !== o.home && o.pattern.test(line)) out.push({ file, line: i + 1, what: o.what });
    }
    if (keepsWebPicks && file !== KEEPER && /\bimage_url\s*:/.test(line)) {
      out.push({ file, line: i + 1, what: "a picked web picture kept by hand: use usePictureFromWeb, which sends the copy shown and says why" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:record-photo-one-block - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Compose RecordPhoto (or the universal SuggestedPhoto panel) instead of EntityImageEdit/SuggestedPhoto, and keep a web pick with usePictureFromWeb");
  process.exit(1);
}
console.log(`lint:record-photo-one-block OK`);
