#!/usr/bin/env tsx
// A row that holds a page's title never refuses to wrap (flex-nowrap): on a phone its controls go under the title, never past the edge.
//
// THE BUG THIS PREVENTS. The Purchases header kept one no-wrap row; at 390 px it ran past the width and its select read All stat (#4390, 2026-10-01)
//
// THE RULE. The element holding a page title (`page-title`, the h1 every
// page header carries) sits in a row that may wrap. A `flex-nowrap` on that
// row, or within the three lines above the title, means its controls have
// nowhere to go on a phone but past the edge. CollectionHeader is the strip
// that already does this right; a one-off row should use it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the lines just above a
// `page-title`: a no-wrap row elsewhere (a toolbar that scrolls on purpose, a
// chip row) is not a page header. Nothing has tested the boundary further yet.
//
//   npx tsx scripts/lint-page-title-rows-wrap.ts   (pnpm lint page-title-rows-wrap)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

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
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\bpage-title\b/.test(lines[i] ?? "")) continue;
    for (let j = Math.max(0, i - 3); j <= i; j++) {
      if (/\bflex-nowrap\b/.test(lines[j] ?? "")) out.push({ file, line: j + 1, what: "a page title's row is flex-nowrap: it cannot wrap on a phone" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:page-title-rows-wrap - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use CollectionHeader from @cobblr/platform-web, or let the row wrap (flex-wrap)");
  process.exit(1);
}
console.log(`lint:page-title-rows-wrap OK`);
