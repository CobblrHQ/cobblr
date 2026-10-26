#!/usr/bin/env tsx
// Every menu (role="menu") takes the keyboard through useMenuFocus from @cobblr/platform-web: focus goes to its first choice on open, the arrows walk its choices, and closing gives focus back to its button.
//
// THE BUG THIS PREVENTS. More inbox actions and the account menu left focus on the button behind them, and Arrow Down scrolled the page (#8163, #8202, 2026-10-24)
//
// THE RULE. A file that draws an element with role="menu" calls
// useMenuFocus(open, ref) for it (HeaderMenu does, so a menu built on
// HeaderMenu passes without saying so). A file that cannot yet is named in
// scripts/menus-take-the-keyboard-waiting.json under the issue that fixes
// it, and leaves the list when it does: a file in the list that already
// calls the hook is refused as a stale entry.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only role="menu": a listbox
// keeps focus in its text box while the arrows pick (a combobox), so it is
// not held to a menu's keys. A component that only renders choices into a
// menu drawn elsewhere has no role="menu" of its own and is not judged.
// Nothing has tested the boundary further yet.
//
// PROVE IT RED: delete the useMenuFocus line from HeaderMenu.tsx and run it.
//
//   npx tsx scripts/lint-menus-take-the-keyboard.ts   (pnpm lint menus-take-the-keyboard)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Issue -> the files whose menu waits for it. */
const WAITING: Record<string, string[]> = JSON.parse(readFileSync("scripts/menus-take-the-keyboard-waiting.json", "utf8")).byIssue;
const waiting = new Map(Object.entries(WAITING).flatMap(([issue, files]) => files.map((f) => [f, issue] as const)));

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const at = lines.findIndex((l) => /\brole="menu"/.test(l));
  const uses = /\buseMenuFocus\(/.test(src);
  const issue = waiting.get(file);
  if (at >= 0 && !uses && !issue) out.push({ file, line: at + 1, what: 'a role="menu" whose file never calls useMenuFocus: opening it leaves focus outside its choices' });
  if (issue && (uses || at < 0)) out.push({ file, line: 1, what: `named in scripts/menus-take-the-keyboard-waiting.json under ${issue}, but its menu already takes the keyboard (or is gone): take it out of the list` });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:menus-take-the-keyboard - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:menus-take-the-keyboard OK`);
