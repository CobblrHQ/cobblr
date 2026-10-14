#!/usr/bin/env tsx
// A DndContext spreads VERTICAL_DRAG so a reorder in a list never moves sideways or past its list, or says drag-2d: why it needs x.
//
// THE BUG THIS PREVENTS. Dragging a sidebar row could carry it off to the
// right, and the nav grew a horizontal scrollbar that kept growing while the
// pointer stayed near its edge (the owner, 2026-10-01, #4514). dnd-kit moves
// the dragged node by the pointer's whole offset unless told otherwise, and
// the auto-scroller then chases the content the row widened; every vertical
// list in the app had the same defaults, so every one of them could do it.
//
// THE RULE. Every `<DndContext` in web/src or modules spreads
// `{...VERTICAL_DRAG}` (web/src/lib/vertical-drag.ts: no sideways offset, and
// the row kept inside its scroller). A drag that really
// moves across, a board card crossing columns, says so with a
// `drag-2d: <why>` comment within the few lines above it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The board view
// (BoardDrag.tsx) is the near-miss: its cards cross columns sideways, so the
// lock would break it. That is why the opt-out exists and why it carries a
// reason. Tests are not judged; they mount contexts of their own.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-vertical-drag-stays-in-its-column.ts   (pnpm lint vertical-drag-stays-in-its-column)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "web/src", "packages"];

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
  for (const m of src.matchAll(/<DndContext\b[^>]*>/g)) {
    const at = m.index ?? 0;
    if (/\{\.\.\.VERTICAL_DRAG\}/.test(m[0])) continue;
    if (/drag-2d:\s*\S/.test(src.slice(Math.max(0, at - 300), at))) continue;
    out.push({ file, line: src.slice(0, at).split("\n").length, what: "a DndContext without {...VERTICAL_DRAG} (or a drag-2d: reason above it)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:vertical-drag-stays-in-its-column - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:vertical-drag-stays-in-its-column OK`);
