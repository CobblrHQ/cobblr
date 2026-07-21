// Server-side view of the label-size registry, DERIVED from the one table in
// ../label-sizes.ts. We only flatten its PaperSize + LabelSize split into the
// single LabelSheet shape the PDF renderer (pdf.ts) wants, resolving sheet
// dimensions from the paper. There is no second list of presets here: add a
// size in label-sizes.ts and it appears in the picker, the preview, the ⌘P
// sheet and the PDF at once.
//
// (This used to be a hand-copied duplicate kept in sync by a comment. It
// drifted the moment a size was added on one side only, which is exactly how
// a size you could pick failed to print.)

import { LABEL_SIZES, findPaper, deriveGrid } from "../label-sizes.js";

export type PrinterFamily = "rollo" | "laser";

export interface LabelSheet {
  key: string;
  label: string;
  printer: PrinterFamily;
  sheet_w: number;
  sheet_h: number;
  margin_t: number;
  margin_l: number;
  col_gap: number;
  row_gap: number;
  cols: number;
  rows: number;
  label_w: number;
  label_h: number;
  subdivisions?: 1 | 2;
  is_sheet_label?: boolean;
}

export const SIZES: LabelSheet[] = LABEL_SIZES.map((s) => {
  const p = findPaper(s.paper);
  if (!p) throw new Error(`label size "${s.key}" names unknown paper "${s.paper}"`);
  const laser = s.paper === "letter";
  return {
    key: s.key,
    label: s.label,
    printer: laser ? "laser" : "rollo",
    sheet_w: p.width_in,
    sheet_h: p.height_in,
    margin_t: s.margin_t,
    margin_l: s.margin_l,
    col_gap: s.col_gap,
    row_gap: s.row_gap,
    cols: s.cols,
    rows: s.rows,
    label_w: s.label_w,
    label_h: s.label_h,
    // Avery presets have fixed pre-cut positions; treat the whole letter
    // family as fixed-grid for the renderer (no size-mixing path).
    is_sheet_label: laser,
  };
});

export function findSize(key: string): LabelSheet | undefined {
  return SIZES.find((s) => s.key === key);
}

/** A workspace-defined size (labels_custom_sizes row, dims in inches) as the
 *  LabelSheet the renderer wants. The grid is DERIVED here, never stored, so the
 *  same 1.5x3-holds-two-1.5in arithmetic the presets validate against drives a
 *  custom size too. Treated as the `rollo` (continuous/cut-guide) family: it gets
 *  the abutting-grid cut guides (computeCellBorders), not the fixed-position
 *  laser-sheet path. The synthetic `custom:<id>` key is how the route and the
 *  renderer refer to it. */
export function buildCustomLabelSheet(row: {
  id: string;
  name: string;
  media_w: number;
  media_h: number;
  label_w: number;
  label_h: number;
  margin_t: number;
  margin_l: number;
  col_gap: number;
  row_gap: number;
}): LabelSheet {
  const g = deriveGrid({
    paper_w: row.media_w,
    paper_h: row.media_h,
    label_w: row.label_w,
    label_h: row.label_h,
    margin_t: row.margin_t,
    margin_l: row.margin_l,
    col_gap: row.col_gap,
    row_gap: row.row_gap,
  });
  return {
    key: `custom:${row.id}`,
    label: row.name,
    printer: "rollo",
    sheet_w: row.media_w,
    sheet_h: row.media_h,
    margin_t: row.margin_t,
    margin_l: row.margin_l,
    col_gap: row.col_gap,
    row_gap: row.row_gap,
    cols: g.cols,
    rows: g.rows,
    label_w: row.label_w,
    label_h: row.label_h,
    is_sheet_label: false,
  };
}
