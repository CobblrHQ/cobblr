#!/usr/bin/env tsx
// A sheet that rises from the foot of a phone (an OverlayLayer anchored with items-end) pads its panel by --inset-bottom, so its last row is never under the home bar.
//
// THE BUG THIS PREVENTS. #7298 (2026-10-18): the station's Set total keypad drew 0 and Delete a digit 20 px from the bottom, inside the iPhone's 34 px home bar.
//
// THE RULE. An `<OverlayLayer` whose className anchors its content to the
// foot (`items-end`) is a bottom sheet on a phone: its panel, the first
// element inside it, mentions `--inset-bottom` in its className or style
// (the pattern is `pb-[max(<padding>,var(--inset-bottom))]`). A sheet that
// cannot reach the foot says `// home-bar: <why>` on the OverlayLayer line.
//
// THE BOUNDARY. A centred or top-anchored OverlayLayer (a Modal, a menu)
// is not judged: its panel never touches the foot. `sm:items-center` still
// counts as a bottom sheet, because on a phone it is one; that is exactly
// the station's keypad. Fixed bars are lint:fixed-chrome's.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-bottom-sheet-clears-the-home-bar.ts   (pnpm lint a-bottom-sheet-clears-the-home-bar)
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
  if (!src.includes("<OverlayLayer")) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("<OverlayLayer")) continue;
    // The opening tag may run over a few lines.
    let tag = line;
    for (let j = i + 1; j < lines.length && !/>\s*$/.test(tag) && j < i + 8; j++) tag += "\n" + lines[j];
    if (!/\bitems-end\b/.test(tag)) continue;
    if (/\/\/ home-bar: \S/.test(line) || /\{\/\* home-bar: \S/.test(lines[i - 1] ?? "")) continue;
    // The panel: the next element after the OverlayLayer's own tag.
    const after = lines.slice(i, i + 16).join("\n");
    const tagEnd = after.indexOf(">", after.indexOf("<OverlayLayer"));
    const rest = after.slice(tagEnd + 1);
    const panelStart = rest.search(/<[a-zA-Z]/);
    // The tag ends at a ">" that is not an arrow's "=>" (an onClick inside it).
    const end = /[^=]>/g;
    end.lastIndex = panelStart;
    const panelEnd = panelStart >= 0 ? (end.exec(rest)?.index ?? rest.length) + 2 : 0;
    const panel = panelStart >= 0 ? rest.slice(panelStart, panelEnd) : "";
    if (/--inset-bottom/.test(panel)) continue;
    out.push({ file, line: i + 1, what: "a bottom sheet whose panel does not clear --inset-bottom: its last row sits under a phone's home bar" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-bottom-sheet-clears-the-home-bar - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("give the sheet's panel pb-[max(<its padding>,var(--inset-bottom))], or say // home-bar: <why> on the OverlayLayer line");
  process.exit(1);
}
console.log(`lint:a-bottom-sheet-clears-the-home-bar OK`);
