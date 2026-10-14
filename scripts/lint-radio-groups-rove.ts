#!/usr/bin/env tsx
// A role=radio button takes its keyboard from rovingRadio (@cobblr/platform-web), so its group is one tab stop and the arrow keys move the pick.
//
// THE BUG THIS PREVENTS. #6160 (2026-10-13): the saved-view Layout picker and eight other hand-built radio groups announced themselves as radio groups, but every option was a tab stop and the arrow keys did nothing
//
// THE RULE. An element whose opening tag says role="radio" spreads
// {...rovingRadio(i, picked)} in that same tag. SegmentedChoice does it for
// every pick of a few; a hand-built group (nine options, a card per option)
// does it itself. A radio whose keys are handled another way says so on the
// line before its tag: // RADIO-KEYS: <why>.
//
// THE BOUNDARY. Only the literal role="radio": a role computed in braces is
// not judged, and none exists. A native <input type="radio"> has the
// browser's own keys and is refused anyway by lint:no-radio-inputs.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-radio-groups-rove.ts   (pnpm lint radio-groups-rove)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** A JSX opening tag from its "<": up to the first ">" outside braces and
 *  strings, so an arrow function's "=>" in a prop does not end it. */
function openTag(src: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let k = from; k < src.length; k++) {
    const c = src[k]!;
    if (quote) {
      if (c === quote && src[k - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(from, k + 1);
  }
  return src.slice(from);
}

/** The check. Every role="radio" tag without rovingRadio and without a
 *  RADIO-KEYS reason. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /role="radio"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = src.lastIndexOf("<", m.index);
    if (start < 0 || !/^<[A-Za-z]/.test(src.slice(start, start + 2))) continue;
    const tag = openTag(src, start);
    if (start + tag.length < m.index) continue;
    if (/\brovingRadio\(/.test(tag)) continue;
    const line = src.slice(0, start).split("\n").length;
    const before = src.split("\n")[line - 2] ?? "";
    if (/RADIO-KEYS: \S/.test(before)) continue;
    out.push({ file, line, what: 'a role="radio" option without rovingRadio: every option is a tab stop and the arrow keys do nothing' });
  }
  return out;
}

if (process.argv[1] && /lint-radio-groups-rove/.test(process.argv[1])) {
const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:radio-groups-rove - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Spread {...rovingRadio(i, pickedIndex)} on each role=radio button, or use SegmentedChoice");
  process.exit(1);
}
console.log(`lint:radio-groups-rove OK`);
}
