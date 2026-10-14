#!/usr/bin/env tsx
// A menu or listbox opens through PopoverLayer, which keeps it on the screen; one positioned absolute inside its row may only be as wide as its anchor (w-full).
//
// THE BUG THIS PREVENTS. the scan card's File into menu on a phone was an absolute 20rem box and ran off the right edge (#3930, 2026-09-28)
//
// THE RULE. Every JSX element with role="menu" or role="listbox" either IS a
// PopoverLayer (portaled, positioned from the trigger's rect, and moved back
// inside the screen with a 16px gutter by the layer itself), or is not
// positioned `absolute`, or is `absolute` AND `w-full`: as wide as the thing
// it hangs under, so it cannot be wider than what is already on the screen.
// A genuine exception says why on one of the three lines above the tag:
// `// ALLOW-ABSOLUTE-MENU: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The projects part picker's
// listbox is `absolute` under its text box and `w-full`, so it takes the
// box's width and can never pass the edge the box itself keeps; that is why
// `w-full` passes. The phone row's tools sheet is role="menu" too, but it is
// a full-width sheet inside an OverlayLayer, not positioned at all, so the
// rule looks only at `absolute`. A menu with no role at all is not seen:
// e2e/no-menu-opens-past-the-edge.mjs walks the reachable ones in a browser.
//
// PROVE IT RED: `git show <before>:web/src/pages/ScanPhoneRow.tsx >
// _tmp/old.tsx && npx tsx scripts/lint-menus-keep-to-the-screen.ts _tmp/old.tsx`
// flags the File into menu that ran off the screen.
//
//   npx tsx scripts/lint-menus-keep-to-the-screen.ts   (pnpm lint menus-keep-to-the-screen)
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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const role = /role="(menu|listbox)"/g;
  for (let m = role.exec(src); m; m = role.exec(src)) {
    const open = openingTag(src, m.index);
    if (!open) continue;
    const line = src.slice(0, open.start).split("\n").length;
    if (/^PopoverLayer\b/.test(open.text.slice(1))) continue;
    const classes = open.text.match(/className=(?:"([^"]*)"|\{[^]*?\})/)?.[0] ?? "";
    if (!/(^|[\s"'`{])absolute($|[\s"'`}])/.test(classes)) continue;
    if (/(^|[\s"'`{])w-full($|[\s"'`}])/.test(classes)) continue;
    const above = src.split("\n").slice(Math.max(0, line - 4), line - 1).join("\n");
    if (/ALLOW-ABSOLUTE-MENU: \S/.test(above)) continue;
    out.push({ file, line, what: `a ${m[1]} positioned absolute inside its row, wider than its anchor: it can run off a phone's edge` });
  }
  return out;
}

/** The JSX opening tag that contains `at`: from its `<Name` to the `>` that
 *  closes it, skipping any `>` inside `{ ... }` (an arrow in a handler). */
function openingTag(src: string, at: number): { start: number; text: string } | null {
  let start = at;
  while (start > 0 && !(src[start] === "<" && /[A-Za-z]/.test(src[start + 1] ?? ""))) start--;
  if (src[start] !== "<") return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return { start, text: src.slice(start, i + 1) };
  }
  return null;
}

const named = process.argv.slice(2);
const violations: Violation[] = [];
if (named.length) for (const file of named) violations.push(...check(file, readFileSync(file, "utf8")));
else for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:menus-keep-to-the-screen - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("render it in a PopoverLayer portaled to document.body, positioned from the trigger's rect (pass flipAbove)");
  process.exit(1);
}
console.log(`lint:menus-keep-to-the-screen OK`);
