#!/usr/bin/env tsx
// A colour class in the app's markup names a colour Tailwind draws: one the theme defines, or Tailwind cannot draw it and the element shows no colour at all.
//
// THE BUG THIS PREVENTS. 2026-10-17 #7058: the vending card's stock chip was bg-panel, a colour the theme never defined, so it had no background and its count vanished over a dark photo; eleven other dead colour classes were in the app
//
// THE RULE. Every colour class (bg-, text-, border-, ring-, fill- and the
// rest, with any variants) in a string of classes is one Tailwind draws with
// web/tailwind.config.js: a semantic token (surface, subtle, line, content,
// muted, danger, accent) or a palette shade that exists. Tailwind says nothing
// about a class it does not know; it just draws nothing. A genuine exception
// opts out on its line with `colour-class-ok: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a string that also
// holds a class Tailwind draws is a class list. "text-delta" (a chat stream's
// event), "fill-known" (an action's id) and "border-box" (a style value) stand
// alone and are not. prose-* variants are lint:prose-is-styled's.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-colour-classes-exist.ts   (pnpm lint colour-classes-exist)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { deadColourClasses, tailwindDraws } from "./lib/colour-classes.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "packages/platform-web/src", "web/src"];

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

const draws = tailwindDraws(process.cwd());

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx") && !/className|class:/.test(src)) return [];
  return deadColourClasses(src, draws).map((d) => ({ file, line: d.line, what: `${d.cls} is a colour Tailwind does not draw` }));
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:colour-classes-exist - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use a colour the theme defines (web/tailwind.config.js): a semantic token (surface, subtle, line, content, muted, danger, accent) or a palette shade that exists.");
  process.exit(1);
}
console.log(`lint:colour-classes-exist OK`);
