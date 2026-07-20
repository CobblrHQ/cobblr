// Label size registry — the ONE table, shared by both consumers:
//   • ui/            the picker, the live preview, and the ⌘P sheet
//   • print/layout   the PDF / direct-to-printer renderer, which DERIVES its
//                    flattened LabelSheet rows from these
// It sits at the module root, not under ui/, precisely so the server side can
// import it without reaching into browser code. Pure data and pure functions:
// keep it that way or the print path can no longer use it, and the two tables
// this replaced start drifting again.
//
// Two concepts the user picks between:
//   • PaperSize  — the physical media that goes through the printer
//                  (US Letter sheet, or a 4×6" label-roll segment).
//   • LabelSize  — how that paper is tiled into individual labels:
//                  label dimensions + margins + gaps + the col×row
//                  grid. Each LabelSize belongs to one PaperSize.
//
// All measurements are inches — the print renderer sets `@page` and
// every box in real inches so the browser's print output is 1:1.

export interface PaperSize {
  key: string;
  label: string;
  width_in: number;
  height_in: number;
}

export const PAPER_SIZES: PaperSize[] = [
  { key: "letter", label: 'US Letter — 8.5 × 11"', width_in: 8.5, height_in: 11 },
  { key: "roll-4x6", label: 'Label roll — 4 × 6"', width_in: 4, height_in: 6 },
  // Die-cut square stock fed straight through a roll printer's adjustable
  // guide. One label per feed, so no cutting: the alternative to tiling
  // squares onto 4×6 and chopping them up.
  { key: "roll-1.5", label: 'Label roll — 1½ × 1½"', width_in: 1.5, height_in: 1.5 },
  { key: "roll-2", label: 'Label roll — 2 × 2"', width_in: 2, height_in: 2 },
];

export interface LabelSize {
  key: string;
  label: string;
  /** PaperSize.key this layout tiles onto. */
  paper: string;
  label_w: number;
  label_h: number;
  margin_t: number;
  margin_l: number;
  col_gap: number;
  row_gap: number;
  cols: number;
  rows: number;
}

// Layouts are validated against their paper: margin_l*2 + cols*label_w
// + (cols-1)*col_gap must fit width_in, likewise for height.
export const LABEL_SIZES: LabelSize[] = [
  // ── 4×6" label roll — zero margins, zero gaps (continuous media) ──
  { key: "roll-2x2", label: '2 × 2" square — 6 up', paper: "roll-4x6", label_w: 2, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 3 },
  { key: "roll-2x3", label: '2 × 3" portrait — 4 up', paper: "roll-4x6", label_w: 2, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 2 },
  { key: "roll-4x2", label: '4 × 2" banner — 3 up', paper: "roll-4x6", label_w: 4, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 3 },
  { key: "roll-4x3", label: '4 × 3" — 2 up', paper: "roll-4x6", label_w: 4, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 2 },
  { key: "roll-4x6", label: '4 × 6" — 1 up', paper: "roll-4x6", label_w: 4, label_h: 6, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },
  // 2 across leaves 1" over on a 4" web, so centre it (½" each side) rather
  // than crowding one edge; the cut lines then sit where a guillotine can
  // take the whole stack in two passes.
  { key: "roll-1.5x1.5", label: '1½ × 1½" square — 8 up', paper: "roll-4x6", label_w: 1.5, label_h: 1.5, margin_t: 0, margin_l: 0.5, col_gap: 0, row_gap: 0, cols: 2, rows: 4 },

  // ── Die-cut square rolls — one label per feed, nothing to cut ──
  { key: "roll15-1up", label: '1½ × 1½" square — 1 up', paper: "roll-1.5", label_w: 1.5, label_h: 1.5, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },
  { key: "roll2-1up", label: '2 × 2" square — 1 up', paper: "roll-2", label_w: 2, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },

  // ── US Letter — laser/inkjet sheet ──
  { key: "letter-2x2", label: '2 × 2" square — 20 up', paper: "letter", label_w: 2, label_h: 2, margin_t: 0.5, margin_l: 0.25, col_gap: 0, row_gap: 0, cols: 4, rows: 5 },
  { key: "letter-3x3", label: '3 × 3" square — 6 up', paper: "letter", label_w: 3, label_h: 3, margin_t: 0.5, margin_l: 0.5, col_gap: 0.5, row_gap: 0.25, cols: 2, rows: 3 },
  { key: "letter-4x2", label: '4 × 2" banner — 5 up', paper: "letter", label_w: 4, label_h: 2, margin_t: 0.5, margin_l: 2.25, col_gap: 0, row_gap: 0, cols: 1, rows: 5 },
  { key: "avery-5160", label: 'Avery 5160 — 1 × 2⅝" address · 30 up', paper: "letter", label_w: 2.625, label_h: 1, margin_t: 0.5, margin_l: 0.1875, col_gap: 0.125, row_gap: 0, cols: 3, rows: 10 },
  { key: "avery-22805", label: 'Avery 22805 — 1½ × 1½" square · 24 up', paper: "letter", label_w: 1.5, label_h: 1.5, margin_t: 0.5, margin_l: 0.7799, col_gap: 0.3132, row_gap: 0.2, cols: 4, rows: 6 },
];

export function findPaper(key: string): PaperSize | undefined {
  return PAPER_SIZES.find((p) => p.key === key);
}

export function findLabelSize(key: string): LabelSize | undefined {
  return LABEL_SIZES.find((s) => s.key === key);
}

export function labelSizesForPaper(paperKey: string): LabelSize[] {
  return LABEL_SIZES.filter((s) => s.paper === paperKey);
}

/** Items per physical sheet for a label size. */
export function perSheet(size: LabelSize): number {
  return size.cols * size.rows;
}

/** Which inner layout a label cell uses, from its aspect ratio.
 *  pickLayout():
 *   • portrait — tall cells: title on top, QR pinned below
 *   • square   — roughly 1:1: title on top, QR fills the rest
 *   • row      — wide cells: QR on the left, text on the right       */
export type CellLayout = "row" | "portrait" | "square";

export function cellLayout(size: LabelSize): CellLayout {
  const aspect = size.label_w / size.label_h;
  if (aspect <= 0.85) return "portrait";
  if (aspect < 1.2) return "square";
  return "row";
}
