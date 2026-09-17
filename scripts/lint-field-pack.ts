#!/usr/bin/env tsx
// A form of field-defs is laid out by FieldPack; no hand-rolled grid-cols container holds FieldRow, ScanFieldInput, CustomFieldInput or EditField.
//
// THE BUG THIS PREVENTS. The 2026-09-16 mobile review (#3067): every form laid
// its fields out by hand, `grid-cols-2` here, one column there, `col-span-2`
// on whatever the author remembered was wide. Five copies of the layout
// decision, five answers. On a 393px phone the scan form's two 170px columns
// put an iOS date input in a column it overran ("Opened" off the right edge,
// "Best before" under "Acquired from"), and the custom-fields panel dodged
// the same overrun by going one-column, spending a phone row on a checkbox.
// The packer (packages/platform-web/src/field-pack.ts) answers the layout
// once from what each field needs; this lint stops the sixth copy.
//
// THE RULE. A line that opens a grid (`grid-cols-` in a className) starts a
// container; while that container is open (until a line returns to its
// indentation), no line may render a field: a field control (<FieldRow,
// <ScanFieldInput, <CustomFieldInput, <EditField, <EditSelect, <InlineText,
// <InlineTextarea) or the caption a form puts over one (<Field, the
// page-local wrapper every record form reached for, or the shared
// <LabeledField). Render the fields through <FieldPack instead. A grid of
// something else (cards, thumbnails, stat tiles) is not touched: the lint
// only bites when a field sits inside it. A <FieldPack inside a grid is the
// packer's own business: its items are skipped, the way a nested grid is
// judged on its own, so a page's two-column layout (cover left, fields
// right) may hold a pack without being blamed for the fields in it.
//
// THERE IS NO OPT-OUT. The first landing honoured `FIELD-PACK-LATER:
// #3107 <reason>` on five pre-existing grids so the primitive could land
// without rewriting them in the same change; #3107 retired the five and
// deleted that hatch with the last one (a suppression with no expiry is
// how "later" becomes "never"). A grid that genuinely cannot use the
// packer is a reason to extend the packer, not to annotate the grid.
//
// WHAT IT CANNOT SEE, written here so the rule does not read as wider than
// it is. The detector matched four control names at first, so a record
// form built from a page-local `<Field>` + `<InlineText>` (the inventory
// part page, the location page) was the same shape and invisible to it;
// #3147 widened it to the caption wrappers (`<Field`, `<LabeledField`) and
// converted the eight grids that surfaced. What stays outside: a grid of
// bare `<label>` + `<input>` with no caption wrapper. A detector for that
// shape flags thirty more grids, almost all settings surfaces (print
// options, the admin console, a channel's form) laid out by hand on
// purpose, which would be a wider decision than #3067 made; a caption
// wrapper is what a record form reaches for, so it is the line. A
// page-local `<Field` on a settings editor whose labels are sentences
// (ScanRulesPage) says why on the component.
//
// PROVE IT RED before you trust it green: the scan form's old
// `grid grid-cols-2` around ScanFieldInput fails it; FieldPack passes.
//
//   npx tsx scripts/lint-field-pack.ts   (pnpm run lint:field-pack)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites: the app's pages and components, the shared package
 *  and module UIs. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const GRID = /className=\{?["'`][^"'`]*\bgrid-cols-/;
const FIELD = /<(FieldRow|ScanFieldInput|CustomFieldInput|EditField|EditSelect|InlineText|InlineTextarea|Field|LabeledField)\b/;
/** A container whose contents are laid out by something other than the grid
 *  this lint is judging: a nested grid, or the packer itself. */
const OWN_LAYOUT = /<FieldPack\b/;

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

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!GRID.test(line)) continue;
    const open = indentOf(line);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() === "") continue;
      // The container closes when a line returns to its indentation.
      if (indentOf(l) <= open) break;
      // A grid nested inside this one is judged on its own, and a FieldPack
      // lays its own items out: skip past either, so a page's two-column
      // layout is not blamed for a field grid or a pack within it.
      if (GRID.test(l) || OWN_LAYOUT.test(l)) {
        const inner = indentOf(l);
        let k = j + 1;
        while (k < lines.length && ((lines[k] ?? "").trim() === "" || indentOf(lines[k] ?? "") > inner)) k++;
        j = k;
        continue;
      }
      const m = FIELD.exec(l);
      if (m) {
        out.push({ file, line: j + 1, what: `<${m[1]}> inside a hand-rolled grid (line ${i + 1}); lay the fields out with <FieldPack>` });
        break;
      }
    }
  }
  return out;
}

if (process.argv[1] && /lint-field-pack\.ts$/.test(process.argv[1])) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:field-pack - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Lay the fields out with <FieldPack> (packages/platform-web/src/FieldPack.tsx). There is no opt-out: a grid the packer cannot express is a reason to extend the packer (#3107).");
    process.exit(1);
  }
  console.log(`lint:field-pack OK`);
}
