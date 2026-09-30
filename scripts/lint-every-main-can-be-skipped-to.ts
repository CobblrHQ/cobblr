#!/usr/bin/env tsx
// Every <main> the web app draws carries id={MAIN_ID} and sits in a file that draws <SkipToContent/>: a page shell without them makes a keyboard user Tab through the whole nav on every page.
//
// THE BUG THIS PREVENTS. No page shell had a skip link, so every page walked a keyboard user through every app in the nav first (#4115, 2026-09-29)
//
// THE RULE. In every .tsx under web/src (tests aside), each `<main` opening
// tag carries `id={MAIN_ID}`, and the file renders `<SkipToContent`. The skip
// link is what a keyboard user reaches first; MAIN_ID is where it lands.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The `<main` element only,
// never a component whose name starts with Main (`<MainPanel`): the tag is
// matched as `<main` followed by a space or `>`. A page INSIDE a shell must
// not draw its own <main>, since the shell's is the one landmark; this lint
// then asks it for a skip link too, which is how a nested main shows up.
//
//   npx tsx scripts/lint-every-main-can-be-skipped-to.ts   (pnpm lint every-main-can-be-skipped-to)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src"];

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
function check(file: string, raw: string): Violation[] {
  if (!/\.tsx$/.test(file)) return [];
  // Comments may name the element ("every <main>"); blank them, keeping
  // lines. Only real comment shapes: a JSX {/* ... */}, and a line that starts
  // as a comment. A bare /* in a string (a route glob) is not one, and
  // treating it as one swallowed half of AdminLayout on the first run.
  const src = raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (c) => c.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? " ".repeat(l.length) : l))
    .join("\n");
  const out: Violation[] = [];
  const mains = [...src.matchAll(/<main[\s>]([^>]*)/g)];
  if (mains.length === 0) return out;
  for (const m of mains) {
    if (!/id=\{MAIN_ID\}/.test(m[0])) {
      out.push({ file, line: src.slice(0, m.index).split("\n").length, what: "<main> without id={MAIN_ID}: the skip link has nowhere to land" });
    }
  }
  if (!/<SkipToContent\b/.test(src)) out.push({ file, line: src.slice(0, mains[0]!.index).split("\n").length, what: "draws a <main> but no <SkipToContent />" });
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:every-main-can-be-skipped-to - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Give the <main> id={MAIN_ID} tabIndex={-1} and render <SkipToContent /> first in the shell (web/src/components/a11y/shell-landmarks.tsx)");
  process.exit(1);
}
console.log(`lint:every-main-can-be-skipped-to OK`);
