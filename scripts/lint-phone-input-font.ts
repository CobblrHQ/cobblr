#!/usr/bin/env tsx
// A form control renders at 16 px or more on a phone: no important text-size utility under 16 px and no inline font-size under 16 px on an input, textarea or select, and index.css keeps the coarse-pointer guard
//
// THE BUG THIS PREVENTS. Tapping the dashboard's "Add another thing" box on an
// iPhone zoomed the page in on itself, which the owner then had to undo
// (#3049, 2026-09-15). Mobile Safari zooms on a focused control whose font is
// under 16 px. index.css carries a guard for that (every input, select and
// textarea renders at max(16px, 1em) under a coarse pointer), and the box
// defeated it with `!text-sm`: Tailwind's important modifier compiles to
// font-size !important on a class selector, which outranks the guard's
// element selector. `.input` is text-sm already, so the `!` bought nothing
// but the zoom.
//
// THE RULE. On an <input>, <textarea> or <select> in web/src, the className
// carries no unprefixed important text-size utility under 16 px (`!text-xs`,
// `!text-sm`, `!text-[13px]`, `!text-[0.8rem]`); a breakpoint-prefixed one
// (`sm:!text-sm`) is fine, since sm is past every phone. No inline
// `style={{ fontSize }}` under 16 px on those elements either. And
// web/src/index.css keeps the coarse-pointer guard, because without it every
// text-sm control zooms. A control that must be small on a desk drops the
// `!` (a utility already beats the `.input` component class) or prefixes it.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified. Red first on WhatToDoPanel's box at
// 5611bc454 (COBBLR_LINT_ROOT=<a checkout> points it at another tree).
//
//   npx tsx scripts/lint-phone-input-font.ts   (pnpm run lint:phone-input-font)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src"].map((r) => join(BASE, r));
const CSS_GUARD = join(BASE, "web/src/index.css");
/** An important text-size utility under 16 px, not behind a breakpoint. */
const SMALL_IMPORTANT = /(?:^|[\s"'`{])!text-(?:xs|sm|\[(?:1[0-5](?:\.\d+)?px|0?\.\d+rem|0?\.\d+em)\])(?=$|[\s"'`}])/;
const SMALL_INLINE = /fontSize:\s*(?:"(?:1[0-5](?:\.\d+)?px|0?\.\d+rem)"|(?:[0-9]|1[0-5])(?![\d.]))/;

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
  if (!/\.tsx$/.test(file)) return out;
  // Each form control's opening tag, attributes included, wherever it spans.
  for (const { name, attrs, index } of controlTags(src)) {
    const line = src.slice(0, index).split("\n").length;
    if (SMALL_IMPORTANT.test(attrs)) {
      out.push({ file, line, what: `<${name}> with an important text size under 16 px; a phone zooms on focus. Drop the ! (a utility already beats .input) or prefix it (sm:!text-sm)` });
    }
    if (SMALL_INLINE.test(attrs)) {
      out.push({ file, line, what: `<${name}> with an inline font-size under 16 px; a phone zooms on focus` });
    }
  }
  return out;
}

/** The opening tags of the form controls, attributes as written. A JSX
 *  attribute holds arrows and braces, so the tag ends at the first `>` that
 *  is outside every brace and string, not at the first `>` at all. */
function* controlTags(src: string): Generator<{ name: string; attrs: string; index: number }> {
  const open = /<(input|textarea|select)\b/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    yield { name: m[1]!, attrs: src.slice(m.index + m[0].length, i), index: m.index };
    open.lastIndex = i;
  }
}

/** The guard every control relies on. */
function cssGuardHolds(): boolean {
  let css: string;
  try {
    css = readFileSync(CSS_GUARD, "utf8");
  } catch {
    return false;
  }
  const block = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/);
  return !!block && /input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*max\(16px,\s*1em\)\s*!important/.test(block[1] ?? "");
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));
if (!cssGuardHolds()) {
  violations.push({ file: CSS_GUARD, line: 1, what: "the coarse-pointer guard is gone: @media (pointer: coarse) { input, select, textarea { font-size: max(16px, 1em) !important } }" });
}

if (violations.length) {
  console.error(`lint:phone-input-font - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:phone-input-font OK`);
