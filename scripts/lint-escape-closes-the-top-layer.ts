#!/usr/bin/env tsx
// A layer that closes on Escape closes through useEscapeToClose (@cobblr/platform-web), which answers only for the layer on top.
//
// THE BUG THIS PREVENTS. #4319: Esc in the photo viewer over a part also closed the part; every dialog closed itself on any Esc
//
// THE RULE. A file that puts a layer on the page (an OverlayLayer, a Modal's
// overlay, anything portalled to <body>) and closes it on Escape from a
// window or document listener must do it through useEscapeToClose, which asks
// the layer stack whether this layer is the one on top. A hand-written
// listener hears every Escape and closes its layer whatever is over it. A
// listener for Escape that does not close a layer (a search box clearing
// itself, an inline editor cancelling) says so on the line or within the
// three above: `// escape-not-a-layer: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Escape on an element's own
// onKeyDown (a field, a combobox, a list's keyboard handler) is never a
// layer's close: it fires only while that element has focus, which a layer
// above it takes away. Only window/document listeners are read.
//
//   npx tsx scripts/lint-escape-closes-the-top-layer.ts   (pnpm lint escape-closes-the-top-layer)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules"];

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

const MARK = /escape-not-a-layer:\s*\S/;
const LAYER = /<OverlayLayer\b|createPortal\(|\bModalOverlay\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\.tsx$/.test(file) || file.endsWith("/useEscapeToClose.ts") || !LAYER.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  // A window/document keydown listener whose handler reads Escape.
  const listens = /\b(?:window|document)\.addEventListener\(\s*["']keydown["']/;
  for (let i = 0; i < lines.length; i++) {
    if (!listens.test(lines[i]!)) continue;
    // The handler is usually declared just above; look back for the function
    // that reads Escape, up to the enclosing effect.
    let j = i;
    while (j > 0 && i - j < 40 && !/useEffect\(/.test(lines[j]!)) j--;
    const body = lines.slice(j, i + 1).join("\n");
    if (!/["']Escape["']/.test(body)) continue;
    const marked = lines.slice(Math.max(0, j - 3), i + 1).some((l) => MARK.test(l));
    if (marked) continue;
    const at = j + 1 + body.split("\n").findIndex((l) => /["']Escape["']/.test(l));
    out.push({ file, line: at, what: "a layer closed on any Escape, whatever is on top of it" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:escape-closes-the-top-layer - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("useEscapeToClose(open, layerRef, onClose) with the ref of the element the layer stack knows (OverlayLayer's ref); a key that is not closing a layer says so: // escape-not-a-layer: <why>");
  process.exit(1);
}
console.log(`lint:escape-closes-the-top-layer OK`);
