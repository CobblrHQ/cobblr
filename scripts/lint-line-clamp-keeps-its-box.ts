#!/usr/bin/env tsx
// A line-clamp-N class never shares an element with a display utility (block, flex, grid, inline, inline-block, inline-flex, table): Tailwind emits display after line-clamp, so the display wins, the -webkit-box the clamp needs is gone, and the text runs on.
//
// THE BUG THIS PREVENTS. All apps cards meant to show a two-line description ran to five lines on a real browser while the jsdom test passed (#4046, 2026-09-29)
//
// THE RULE. A class string (any quoted literal) holding `line-clamp-N` may
// not also hold a display utility: block, inline-block, inline, flex,
// inline-flex, grid, inline-grid, table, contents, flow-root, list-item,
// with or without a variant (`sm:flex` breaks the clamp from sm up).
// `line-clamp-N` sets display: -webkit-box itself, so the element is already
// a box; the display class adds nothing but the bug. No opt-out: a clamp that
// needs another display is not a clamp, and wants `truncate` or a wrapper.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The string, not the
// element: a parent `flex` and a child `line-clamp-2` are fine, and so is
// `hidden` (display: none is the point) and `line-clamp-none`. Nothing has
// tested a class built across two strings yet (clsx("block", clamp && ...));
// that shape was not in the tree when this was written.
//
//   npx tsx scripts/lint-line-clamp-keeps-its-box.ts   (pnpm lint line-clamp-keeps-its-box)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

const DISPLAY = new Set(["block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "table", "contents", "flow-root", "list-item"]);
const LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

/** The display classes that share a string with a line-clamp-N, if any. */
export function clampBreakers(classes: string): string[] {
  const tokens = classes.split(/\s+/).filter(Boolean);
  if (!tokens.some((t) => /(^|:)line-clamp-\d+$/.test(t))) return [];
  return tokens.filter((t) => DISPLAY.has(t.split(":").pop() ?? ""));
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  for (const m of src.matchAll(LITERAL)) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    if (!text.includes("line-clamp-")) continue;
    const bad = clampBreakers(text);
    if (bad.length) {
      const line = src.slice(0, m.index).split("\n").length;
      out.push({ file, line, what: `${bad.join(", ")} beside a line-clamp resets its box, so the text is not clamped` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:line-clamp-keeps-its-box - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Drop the display class: line-clamp-N is already a block-level box");
  process.exit(1);
}
console.log(`lint:line-clamp-keeps-its-box OK`);
