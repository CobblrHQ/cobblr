// Server-side label-size table for the PDF renderer. Mirrors the web's
// ui/sizes.ts (the visual source of truth) — SAME keys (roll-2x2, letter-2x2,
// avery-22805, …) so a size picked in the QueuePage resolves here. We flatten
// the web's PaperSize + LabelSize split into the one LabelSheet shape the
// renderer (pdf.ts) consumes (sheet dims resolved from the paper). Keep in
// lockstep with ui/sizes.ts when adding/editing presets.

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

const PAPERS: Record<string, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  "roll-4x6": { w: 4, h: 6 },
};

// Same rows as web/ui/sizes.ts LABEL_SIZES.
const RAW: Array<{
  key: string; label: string; paper: string;
  label_w: number; label_h: number;
  margin_t: number; margin_l: number; col_gap: number; row_gap: number;
  cols: number; rows: number;
}> = [
  { key: "roll-2x2", label: '2 x 2" square — 6 up', paper: "roll-4x6", label_w: 2, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 3 },
  { key: "roll-2x3", label: '2 x 3" portrait — 4 up', paper: "roll-4x6", label_w: 2, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 2 },
  { key: "roll-4x2", label: '4 x 2" banner — 3 up', paper: "roll-4x6", label_w: 4, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 3 },
  { key: "roll-4x3", label: '4 x 3" — 2 up', paper: "roll-4x6", label_w: 4, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 2 },
  { key: "roll-4x6", label: '4 x 6" — 1 up', paper: "roll-4x6", label_w: 4, label_h: 6, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },
  { key: "letter-2x2", label: '2 x 2" square — 20 up', paper: "letter", label_w: 2, label_h: 2, margin_t: 0.5, margin_l: 0.25, col_gap: 0, row_gap: 0, cols: 4, rows: 5 },
  { key: "letter-3x3", label: '3 x 3" square — 6 up', paper: "letter", label_w: 3, label_h: 3, margin_t: 0.5, margin_l: 0.5, col_gap: 0.5, row_gap: 0.25, cols: 2, rows: 3 },
  { key: "letter-4x2", label: '4 x 2" banner — 5 up', paper: "letter", label_w: 4, label_h: 2, margin_t: 0.5, margin_l: 2.25, col_gap: 0, row_gap: 0, cols: 1, rows: 5 },
  { key: "avery-5160", label: 'Avery 5160 — 1 x 2.625" address · 30 up', paper: "letter", label_w: 2.625, label_h: 1, margin_t: 0.5, margin_l: 0.1875, col_gap: 0.125, row_gap: 0, cols: 3, rows: 10 },
  { key: "avery-22805", label: 'Avery 22805 — 1.5 x 1.5" square · 24 up', paper: "letter", label_w: 1.5, label_h: 1.5, margin_t: 0.5, margin_l: 0.7799, col_gap: 0.3132, row_gap: 0.2, cols: 4, rows: 6 },
];

export const SIZES: LabelSheet[] = RAW.map((s) => {
  const p = PAPERS[s.paper] ?? PAPERS["roll-4x6"]!;
  const laser = s.paper === "letter";
  return {
    key: s.key,
    label: s.label,
    printer: laser ? "laser" : "rollo",
    sheet_w: p.w,
    sheet_h: p.h,
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
