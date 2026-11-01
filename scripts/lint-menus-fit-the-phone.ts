#!/usr/bin/env tsx
// A box hung from one side (absolute, left-0 or right-0) with a fixed width of 12rem or more carries a viewport clamp (max-w-[calc(100vw-2rem)]), so at 200% text it never runs off a phone.
//
// THE BUG THIS PREVENTS. the notifications and search panels, w-80, are 640 px at 200% text on a 393 px phone (#9080, #9081, 2026-11-01)
//
// THE RULE. One class list that holds `absolute`, an unprefixed `left-0` or
// `right-0`, and an unprefixed fixed width of 12rem or more (`w-48` and up,
// `w-[13rem]`, or `w-[Npx]` over 361 px) also holds a viewport clamp: a
// `max-w-[...]` whose value names `vw`. Widths are rem, so 200% text doubles
// them: `w-80` is 320 px at 100% and 640 px at 200%, and hung from a button
// near a phone's edge it runs off the other one. 12rem is where that starts
// (384 px at 200%, past the 361 px a 393 px phone leaves inside its gutter).
// A menu that needs to place itself is better hung in PopoverLayer, which
// keeps itself on the screen. A box that cannot reach a phone says why on the
// same line, `PHONE-MENU: <reason>` in a comment.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. One class list on one line.
// A width set only at a breakpoint (`sm:w-80`) is a desk's, not a phone's,
// and is not judged; nor is a width from a style attribute or a class list
// built across lines. Nothing has tested the boundary past those yet.
//
//   npx tsx scripts/lint-menus-fit-the-phone.ts   (pnpm lint menus-fit-the-phone)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** An unprefixed fixed width that, doubled by 200% text, is wider than a phone leaves (361 px). */
function tooWideForAPhone(t: string): boolean {
  const scale = /^w-(\d+(?:\.\d+)?)$/.exec(t);
  if (scale) return Number(scale[1]) * 0.25 * 32 > 361;
  const rem = /^w-\[(\d+(?:\.\d+)?)rem\]$/.exec(t);
  if (rem) return Number(rem[1]) * 32 > 361;
  const px = /^w-\[(\d+)px\]$/.exec(t);
  return !!px && Number(px[1]) > 361;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/(\/\/|\/\*) PHONE-MENU: \S/.test(line)) continue;
    for (const list of line.match(/["'`][^"'`]*["'`]/g) ?? []) {
      const tokens = list.slice(1, -1).split(/\s+/);
      if (!tokens.includes("absolute") || !tokens.some((t) => t === "left-0" || t === "right-0")) continue;
      const wide = tokens.find((t) => tooWideForAPhone(t));
      if (!wide || tokens.some((t) => /^max-w-\[[^\]]*vw/.test(t))) continue;
      out.push({ file, line: i + 1, what: `a box hung from one side at ${wide} with no viewport clamp: at 200% text it runs off a phone` });
      break;
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:menus-fit-the-phone - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add max-w-[calc(100vw-2rem)] beside the width, or hang it in PopoverLayer");
  process.exit(1);
}
console.log(`lint:menus-fit-the-phone OK`);
