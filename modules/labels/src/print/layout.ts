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

import { LABEL_SIZES, findPaper } from "../label-sizes.js";

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
