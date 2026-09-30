#!/usr/bin/env tsx
// An element that says aria-modal is an OverlayLayer (which then holds focus through useDialogFocus) or sits in a file that calls useDialogFocus itself: a dialog that only says it is modal lets Tab walk out into the page behind it.
//
// THE BUG THIS PREVENTS. Every dialog in the app let Tab walk out behind its backdrop, never moved focus in, never gave it back, and the confirm's Enter meant yes on Cancel (#4115, 2026-09-29)
//
// THE RULE. Every `aria-modal` in a .tsx under web/src, packages or modules is
// an attribute of an `<OverlayLayer` element (read back to the `<` that opens
// the tag it sits in), or the file calls `useDialogFocus(` itself (Modal.tsx's
// overlay does). No opt-out: a surface that is modal holds the keyboard, and
// one that is not should not say aria-modal.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only `aria-modal`, not
// `role="dialog"`: the "switch to the sidebar?" offer and a tile's dormant
// action are non-modal dialogs, popovers beside the page, and trapping focus
// in them would be the bug. Tests are skipped (they build dialogs on purpose).
//
//   npx tsx scripts/lint-dialogs-hold-focus.ts   (pnpm lint dialogs-hold-focus)
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

/** The name of the JSX tag whose attributes hold `at`: the last `<Name` on a
 *  code line at or above it (comment lines skipped, since a comment that
 *  says "on <html>" is not a tag). */
export function openingTag(src: string, at: number): string {
  const lines = src.slice(0, at).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("{/*") || t.startsWith("/*")) continue;
    const tags = [...line.matchAll(/<([A-Za-z][\w.]*)/g)];
    const last = tags[tags.length - 1];
    if (last) return last[1] ?? "?";
  }
  return "?";
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\.tsx$/.test(file)) return [];
  if (/\buseDialogFocus\(/.test(src)) return [];
  const out: Violation[] = [];
  for (const m of src.matchAll(/\baria-modal\b/g)) {
    const at = m.index ?? 0;
    const tag = openingTag(src, at);
    if (tag !== "OverlayLayer") {
      out.push({ file, line: src.slice(0, at).split("\n").length, what: `<${tag} aria-modal> says it is a dialog but nothing holds focus in it` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:dialogs-hold-focus - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Render it as <OverlayLayer aria-modal=\"true\" ...>, or call useDialogFocus in the component");
  process.exit(1);
}
console.log(`lint:dialogs-hold-focus OK`);
