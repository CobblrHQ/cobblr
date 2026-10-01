#!/usr/bin/env tsx
// A selection bar action that needs an answer opens a FooterActionPopover on the bar, never a modal over the list.
//
// THE BUG THIS PREVENTS. Inventory's Move to… on the selection bar opened a
// blocking modal: the page dimmed, the ticked rows went behind it, and the
// answer was a dropdown in the middle of the screen (the owner, 2026-10-01,
// #4514). Tag did the same on three pages, each with its own copy of the
// modal.
//
// THE RULE. Inside a `<BulkActionBar ... actions={...}>` block, no button
// opens a dialog by flipping a `set...Open(true)` state. A bulk action that
// needs an answer is a FooterActionPopover (or a component built on it, such
// as BulkTagAction): anchored to its button, no dim, Esc closes it, Undo in
// the toast. A genuine exception carries `bulk-modal-ok: <why>` inside the
// block.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Delete asks through
// useConfirm, an awaited call, not an open-state, and stays: a destructive
// action with no undo is the one place a blocking question is right. The
// rule reads only the bar's own actions block; a modal the same page opens
// from a banner (Inventory's "these look like they belong in a list") is not
// the bar's.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-bulk-actions-open-from-the-bar.ts   (pnpm lint bulk-actions-open-from-the-bar)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
  for (const m of src.matchAll(/<BulkActionBar\b/g)) {
    const start = src.indexOf("actions={", m.index ?? 0);
    if (start < 0) continue;
    let depth = 0;
    let end = src.length;
    for (let i = start + "actions=".length; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const block = src.slice(start, end);
    if (/bulk-modal-ok:\s*\S/.test(block)) continue;
    for (const o of block.matchAll(/\bset\w*Open\(true\)/g)) {
      const at = start + (o.index ?? 0);
      out.push({ file, line: src.slice(0, at).split("\n").length, what: `${o[0]} opens a dialog from the selection bar; use FooterActionPopover` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:bulk-actions-open-from-the-bar - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:bulk-actions-open-from-the-bar OK`);
