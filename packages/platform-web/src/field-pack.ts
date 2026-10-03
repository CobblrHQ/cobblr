// One packer for every field a form renders, built in and user-defined (#3067).
//
// The owner, on his phone: "thinking to save vertical space by making
// category and acquired from each a half width dropdown that can pack into
// the same row. some of these are dynamic/user defined so it needs
// intelligence to do properly." And: "all fields, not just dynamic fields."
//
// Every form used to lay its fields out by hand: `grid-cols-2` here, one
// column there, a `col-span-2` on whatever the author remembered was wide.
// On a 393px phone that gave two 170px columns, and iOS draws an empty date
// input wider than that, so "Opened" ran off the right edge and "Best
// before" ran under "Acquired from" (IMG_0798). The custom-fields panel's
// answer was to go one-column on phones, which spends a whole row on a
// checkbox.
//
// This module answers the layout ONCE, from what each field needs and how
// wide the form is:
//
//   - a field's NEED is the narrowest column its control is usable in,
//     derived from the control fieldControl() already decided (a date needs
//     more than a checkbox), the longest choice of a dropdown, the label
//     (a long label must fit its column); never from the field's name, and
//     never from the help under it, which folds to two lines under its own
//     field (HelpText) instead of taking the row: a vehicle's Year, Trim,
//     Plate and Mileage each took a whole row because Trim and Mileage
//     carried a sentence of help (#4518);
//   - the COLUMNS come from the width: as many as fit at MIN_COL_PX, so
//     two short fields share a row on any phone while a desktop form takes
//     four, and a date spans two columns where one would be too narrow;
//   - the PACKING walks the fields in their declared order and gives each
//     the columns it needs; a field that does not fit the rest of its row
//     starts the next one. Order is never changed: the form's author put
//     Best before beside Opened for a reason.
//
// Pure, so the invariants are tested without a browser: no row holds more
// columns than the grid has (so nothing can overlap or leave the screen),
// every field is placed exactly once, in order, and a full-row field is
// alone on its row. FieldPack.tsx is the component that measures the width
// and renders the rows this returns.

import type { FieldControl } from "./fieldControl";

/** What a field needs of the row, in CSS px. */
export interface FieldNeed {
  key: string;
  /** The narrowest column, in CSS px, the control is usable in. */
  minPx: number;
  /** The whole row whatever the width: a paragraph, a picker that opens a
   *  drawer under itself, a long value. */
  full?: boolean;
  /** How wide the field would LIKE to be, past its minimum: a short typed
   *  value read whole. The packer grants it up to half the row and never
   *  more, so a wish never costs its neighbour the row. */
  wantPx?: number;
}

export interface PackOptions {
  /** The gap between columns. Default 12. */
  gapPx?: number;
  /** The narrowest column the grid will make. Default MIN_COL_PX. */
  minColPx?: number;
  /** The most columns the grid will make. Default 4. */
  maxCols?: number;
}

export interface PackedCell {
  key: string;
  /** How many grid columns the field spans. */
  span: number;
  /** 0-based row and column of the cell's left edge. */
  row: number;
  col: number;
}

export interface FieldPacking {
  cols: number;
  /** One column's width at this packing, in CSS px. */
  colPx: number;
  rows: number;
  cells: PackedCell[];
}

/** The narrowest column the grid makes. Low enough that a 320px phone's
 *  form (286px inside the item sheet) still splits in two, so two short
 *  fields share a row there too: at 150 that form was one column and
 *  every field, a dropdown of five words included, took a row of its own.
 *  Every compact control's own minimum is at most this, except a date,
 *  which asks for DATE_MIN_PX and spans two columns when one is narrower. */
export const MIN_COL_PX = 130;

/** A native date control is the widest compact field: iOS renders its value
 *  as prose ("Sep 17, 2026") with padding either side, and an empty one
 *  wider than a 125px column ("Opened" off the right edge, IMG_0798). */
export const DATE_MIN_PX = 150;

/** The gap between columns, matched to the forms' gap-3. */
export const GAP_PX = 12;

/**
 * Pack `needs`, in order, into a grid `widthPx` wide.
 */
export function packFields(needs: readonly FieldNeed[], widthPx: number, opts: PackOptions = {}): FieldPacking {
  const gap = opts.gapPx ?? GAP_PX;
  const minCol = opts.minColPx ?? MIN_COL_PX;
  const maxCols = opts.maxCols ?? 4;
  const width = Math.max(0, widthPx);
  const cols = Math.max(1, Math.min(maxCols, Math.floor((width + gap) / (minCol + gap))));
  const colPx = Math.max(0, (width - gap * (cols - 1)) / cols);
  // A field spanning k columns gets k·col + (k−1)·gap of width.
  const columnsFor = (px: number): number => {
    const k = Math.ceil((px + gap) / (colPx + gap));
    return Math.max(1, Math.min(cols, Number.isFinite(k) ? k : cols));
  };
  // Half the row: the most a WISH may take, so two short fields always
  // share a row on a phone (the owner: "condition and acquired from can
  // each be half width same row").
  const half = Math.max(1, Math.floor(cols / 2));
  const spanOf = (n: FieldNeed): number => {
    if (n.full) return cols;
    const need = columnsFor(n.minPx);
    return n.wantPx && n.wantPx > n.minPx ? Math.max(need, Math.min(half, columnsFor(n.wantPx))) : need;
  };
  const cells: PackedCell[] = [];
  let row = 0;
  let col = 0;
  for (const n of needs) {
    const span = spanOf(n);
    if (col > 0 && col + span > cols) {
      row++;
      col = 0;
    }
    cells.push({ key: n.key, span, row, col });
    col += span;
    if (col >= cols) {
      row++;
      col = 0;
    }
  }
  const rows = cells.length === 0 ? 0 : cells[cells.length - 1]!.row + 1;
  return { cols, colPx, rows, cells };
}

/** What the packer needs to know about a field to size it. Everything here
 *  comes from the field's definition and the control already chosen for it;
 *  nothing from its name. */
export interface FieldSpace {
  /** The control fieldControl() chose, or one of the form-level controls a
   *  field def does not describe: a location picker with a drawer under it,
   *  a plain picker button, a read-only line. */
  control: FieldControl | "location" | "picker" | "readonly";
  label: string;
  choices?: readonly string[] | null;
  /** The value shown now, when known: a long one wants the row. */
  valueLength?: number;
  /** The help under the field. It never widens the field (it folds under
   *  it); kept so a caller can pass the whole field. */
  help?: string | null;
}

/** The narrowest usable column per control, in CSS px, at a 16px input font
 *  (the phone rule): the control's chrome plus room for a short value. */
const CONTROL_MIN_PX: Record<FieldSpace["control"], number> = {
  checkbox: 120,
  number: 110,
  money: 220,
  date: DATE_MIN_PX,
  choice: 120,
  text: MIN_COL_PX,
  url: MIN_COL_PX,
  color: 170,
  computed: 150,
  "server-managed": 150,
  relation: 200,
  member: 200,
  person: 200,
  picker: 200,
  readonly: 150,
  markdown: 320,
  location: 220,
};

/** A small mono uppercase label: ~7px a character at 10px, plus padding. */
const LABEL_PX_PER_CHAR = 7;
/** A 16px input: ~8.5px a character, plus the control's own padding. */
const VALUE_PX_PER_CHAR = 8.5;
const CHOICE_CHROME_PX = 44;
/** An input's own padding and border, either side. */
const INPUT_CHROME_PX = 26;
/** The controls whose value is typed text a column can be too narrow for. */
const TYPED: ReadonlySet<FieldSpace["control"]> = new Set(["text", "url", "number"]);
/** Past this a value is prose and wants the row. Up to it, a value is short
 *  and keeps a half row beside its neighbour, even where the half cannot
 *  show every character (a 172px phone column holds about 17). */
const LONG_VALUE_CHARS = 24;

/** A field's need from its definition and control. */
export function fieldNeed(key: string, space: FieldSpace): FieldNeed {
  const control = space.control;
  if (control === "markdown" || control === "location") return { key, minPx: CONTROL_MIN_PX[control], full: true };
  if ((space.valueLength ?? 0) > LONG_VALUE_CHARS) return { key, minPx: CONTROL_MIN_PX[control], full: true };
  let minPx = CONTROL_MIN_PX[control];
  if (control === "choice" && space.choices?.length) {
    const longest = space.choices.reduce((m, c) => Math.max(m, c.length), 0);
    minPx = Math.max(minPx, Math.round(longest * VALUE_PX_PER_CHAR) + CHOICE_CHROME_PX);
  }
  // A label may wrap to two lines above its control, so it asks for half
  // its single-line width: "Once opened, good for (days)" over a number box
  // is two short lines in a half column, not a whole row for a number.
  const labelPx = Math.ceil((space.label.trim().length * LABEL_PX_PER_CHAR) / 2) + 8;
  minPx = Math.max(minPx, labelPx);
  // A typed value shorter than prose would like to be read whole (an
  // 18-character machine name scrolled in a half-column input, #3107), so
  // it WISHES for the width. A wish, not a need: it may widen the column up
  // to half the row on a wide form, and never takes the row from a short
  // neighbour ("Acquired from" with a marketplace in it used to push
  // Condition onto a row of its own).
  if (TYPED.has(control) && space.valueLength) {
    const wantPx = Math.round(space.valueLength * VALUE_PX_PER_CHAR) + INPUT_CHROME_PX;
    if (wantPx > minPx) return { key, minPx, wantPx };
  }
  return { key, minPx };
}
