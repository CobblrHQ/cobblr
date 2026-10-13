#!/usr/bin/env tsx
// A button whose filled style switches on a condition says its state to assistive tech (aria-pressed, aria-checked, aria-selected, aria-current, or a radio/tab/switch role), or is a SegmentedChoice, so a pick is never told by colour alone.
//
// THE BUG THIS PREVENTS. #6045 (2026-10-12): a connection's Off / Just me / Share showed the pick only by bg-cobble-600; a person could not tell whether a key was off or shared before saving
//
// THE RULE. A <button> whose className picks a FILLED style (bg-cobble-600,
// bg-accent-600, bg-ember-600 with white text) on one side of a condition is
// a toggle or a pick, and the condition is its state. It must say that state
// to assistive tech: aria-pressed, aria-checked, aria-selected, aria-current,
// or role radio/tab/switch/menuitemcheckbox on the same element. The better
// fix for a pick of a few is SegmentedChoice (@cobblr/platform-web), which
// is a radio group and marks the pick with a check as well as its fill.
// A button that is filled for another reason (a primary action that dims while
// busy) says so on the line before it: // COLOUR-NOT-STATE: <why>.
//
// THE BOUNDARY. Only filled-with-white-text styles: a hover tint or a
// border-only highlight is not a state on its own. The 48 buttons (in 30
// files) on main when the rule arrived were fixed or marked in #6086, and
// their baseline deleted: every button now holds to it.
//
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

const FILLED = /\?\s*["'`][^"'`]*\bbg-(?:cobble|accent|ember)-6\d0\b[^"'`]*\btext-white\b|:\s*["'`][^"'`]*\bbg-(?:cobble|accent|ember)-6\d0\b[^"'`]*\btext-white\b/;
const SAYS_STATE = /aria-(?:pressed|checked|selected|current)\b|role=["'{](?:radio|tab|switch|menuitemcheckbox)\b/;

/** A JSX element's opening tag: up to the first ">" at brace depth zero,
 *  outside a string. */
function openTag(el: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < el.length; i++) {
    const c = el[i]!;
    if (quote) {
      if (c === quote && el[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return el.slice(0, i + 1);
  }
  return el;
}

/** The check. Every <button> in the file whose fill switches on a condition
 *  and that does not say its state. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /<button\b[\s\S]*?<\/button>/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const el = m[0];
    // The opening tag only: a button's children are not its state. Its end is
    // the first ">" outside any {...}, so an onClick's "=>" does not end it.
    const open = openTag(el);
    if (!FILLED.test(open) || SAYS_STATE.test(open)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const before = src.split("\n")[line - 2] ?? "";
    if (/COLOUR-NOT-STATE: \S/.test(before)) continue;
    const name = el.slice(open.length).replace(/<[^>]*>/g, " ").replace(/\{[^{}]*\}/g, " ").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    out.push({ file, line, what: `"${name || "a button"}" shows whether it is picked only by its fill` });
  }
  return out;
}

if (process.argv[1] && /lint-selected-not-by-colour-alone/.test(process.argv[1])) {
  const bad: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) bad.push(...check(file, readFileSync(file, "utf8")));
  if (bad.length) {
    console.error(`lint:selected-not-by-colour-alone - ${bad.length} button(s) show their state by colour alone:`);
    for (const v of bad) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Use SegmentedChoice from @cobblr/platform-web for a pick of a few, or add aria-pressed / aria-checked to the button; a fill that is not a state says // COLOUR-NOT-STATE: <why> on the line before.");
    process.exit(1);
  }
  console.log("lint:selected-not-by-colour-alone OK (no button tells its state by colour alone)");
}
