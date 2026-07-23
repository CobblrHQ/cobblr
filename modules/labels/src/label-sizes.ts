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

const MM_PER_IN = 25.4;

/** The physical class of a print medium: cut SHEETS (Letter, Avery) vs a label
 *  ROLL (continuous or die-cut). This is the ONE thing that decides which printer
 *  can run it — an inkjet feeds sheets only, a thermal printer feeds either — so it
 *  is an explicit field, never sniffed from the key. */
export type MediaClass = "sheet" | "roll";

export interface PaperSize {
  key: string;
  label: string;
  width_in: number;
  height_in: number;
  class: MediaClass;
}

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

const mm = (n: number): number => n / MM_PER_IN;

/** A metric thermal label roll as a PaperSize — so common sizes like 50×30 are
 *  selectable everywhere, including system-printing to a "dumb" thermal printer
 *  that Cobblr isn't connected to. */
function rollMedia(wMm: number, hMm: number): PaperSize {
  return { key: `roll-${wMm}x${hMm}mm`, label: `Label roll — ${wMm} × ${hMm} mm`, width_in: mm(wMm), height_in: mm(hMm), class: "roll" };
}
/** A 1-up (or n-across) layout on a metric roll. faceW divides the media exactly,
 *  so n faces tile the width with no float drift. */
function rollLabel(wMm: number, hMm: number, across: number): LabelSize {
  return {
    key: `roll-${wMm}x${hMm}-${across}up`,
    label: across > 1 ? `${wMm} × ${hMm} mm — ${across} up (${Math.round(wMm / across)} × ${hMm} mm each)` : `${wMm} × ${hMm} mm — 1 up`,
    paper: `roll-${wMm}x${hMm}mm`,
    label_w: mm(wMm) / across,
    label_h: mm(hMm),
    margin_t: 0,
    margin_l: 0,
    col_gap: 0,
    row_gap: 0,
    cols: across,
    rows: 1,
  };
}
// The ubiquitous cheap thermal roll sizes; `across` lists the offered n-up layouts
// (2-up only where each face stays a usable width).
const METRIC_ROLLS: { w: number; h: number; across: number[] }[] = [
  { w: 50, h: 30, across: [1, 2] },
  { w: 40, h: 30, across: [1, 2] },
  { w: 40, h: 20, across: [1] },
  { w: 30, h: 20, across: [1] },
  { w: 25, h: 25, across: [1] },
];

export const PAPER_SIZES: PaperSize[] = [
  { key: "letter", label: 'US Letter — 8.5 × 11"', width_in: 8.5, height_in: 11, class: "sheet" },
  { key: "roll-4x6", label: 'Label roll — 4 × 6"', width_in: 4, height_in: 6, class: "roll" },
  // Die-cut square stock fed straight through a roll printer's adjustable
  // guide. One label per feed, so no cutting: the alternative to tiling
  // squares onto 4×6 and chopping them up.
  { key: "roll-1.5", label: 'Label roll — 1½ × 1½"', width_in: 1.5, height_in: 1.5, class: "roll" },
  { key: "roll-2", label: 'Label roll — 2 × 2"', width_in: 2, height_in: 2, class: "roll" },
  ...METRIC_ROLLS.map((r) => rollMedia(r.w, r.h)),
];

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

  // ── Metric thermal rolls (50×30, 40×30, …) — 1-up, plus 2-up where it fits ──
  ...METRIC_ROLLS.flatMap((r) => r.across.map((a) => rollLabel(r.w, r.h, a))),

  // ── US Letter — laser/inkjet sheet ──
  { key: "letter-2x2", label: '2 × 2" square — 20 up', paper: "letter", label_w: 2, label_h: 2, margin_t: 0.5, margin_l: 0.25, col_gap: 0, row_gap: 0, cols: 4, rows: 5 },
  { key: "letter-3x3", label: '3 × 3" square — 6 up', paper: "letter", label_w: 3, label_h: 3, margin_t: 0.5, margin_l: 0.5, col_gap: 0.5, row_gap: 0.25, cols: 2, rows: 3 },
  { key: "letter-4x2", label: '4 × 2" banner — 5 up', paper: "letter", label_w: 4, label_h: 2, margin_t: 0.5, margin_l: 2.25, col_gap: 0, row_gap: 0, cols: 1, rows: 5 },
  { key: "avery-5160", label: 'Avery 5160 — 1 × 2⅝" address · 30 up', paper: "letter", label_w: 2.625, label_h: 1, margin_t: 0.5, margin_l: 0.1875, col_gap: 0.125, row_gap: 0, cols: 3, rows: 10 },
  { key: "avery-22805", label: 'Avery 22805 — 1½ × 1½" square · 24 up', paper: "letter", label_w: 1.5, label_h: 1.5, margin_t: 0.5, margin_l: 0.7799, col_gap: 0.3132, row_gap: 0.2, cols: 4, rows: 6 },
];

/** Media classes in picker order, with their section label. */
export const MEDIA_CLASSES: { class: MediaClass; label: string }[] = [
  { class: "roll", label: "Label rolls" },
  { class: "sheet", label: "Sheets" },
];

/** Group papers into the picker's sections (Label rolls / Sheets), dropping empty
 *  sections. The ONE grouping every size picker uses, so they read the same. */
export function groupPapersByClass(papers: PaperSize[]): { class: MediaClass; label: string; papers: PaperSize[] }[] {
  return MEDIA_CLASSES.map((c) => ({ ...c, papers: papers.filter((p) => p.class === c.class) })).filter((g) => g.papers.length > 0);
}

/** The "what are you printing on?" filter, used when no printer's capability is
 *  narrowing the list (system print). "all" passes everything through. */
export type MediaTypeFilter = "all" | MediaClass;
export function papersOfType(papers: PaperSize[], filter: MediaTypeFilter): PaperSize[] {
  return filter === "all" ? papers : papers.filter((p) => p.class === filter);
}

export function findPaper(key: string): PaperSize | undefined {
  return PAPER_SIZES.find((p) => p.key === key);
}

export function findLabelSize(key: string): LabelSize | undefined {
  return LABEL_SIZES.find((s) => s.key === key);
}

export function labelSizesForPaper(paperKey: string): LabelSize[] {
  return LABEL_SIZES.filter((s) => s.paper === paperKey);
}

// ── the printer-capability funnel ────────────────────────────────────
// One rule, used on every size surface (auto-print, queue, inline config): a
// printer has a KIND (inkjet/laser sheet vs thermal roll) and a MAX WIDTH it can
// feed, and it is only ever offered the sizes that fit. Derived from the printer,
// never from the loaded label (a thermal printer can't report what's loaded).
export type PrinterKind = "inkjet-laser" | "thermal";
export interface PrinterCapability {
  kind: PrinterKind;
  maxWidthMm: number;
}

/** A printer's media capability, from its driver + saved settings. Bluetooth =
 *  thermal, max from the matched profile; network (CUPS/edge) = whatever the user
 *  set on the printers page (a manager can't report it), defaulting to a desktop
 *  sheet printer. */
export function printerCapability(driver: string, settings?: Record<string, unknown> | null): PrinterCapability {
  const s = settings ?? {};
  if (driver === "browser-bluetooth") {
    const max = Number(s.maxWidthMm) || (Number(s.widthDots) ? Number(s.widthDots) / 8 : 0) || 54;
    return { kind: "thermal", maxWidthMm: max };
  }
  const kind: PrinterKind = s.printerKind === "thermal" ? "thermal" : "inkjet-laser";
  const max = Number(s.maxWidthMm) || (kind === "thermal" ? 104 : 216); // 4" roll or 8.5" sheet
  return { kind, maxWidthMm: max };
}

/** The max width is the real constraint — nothing wider than the printer can feed.
 *  Beyond that, an inkjet/laser feeds SHEETS only (it can't take a thermal roll),
 *  while a thermal printer runs either a roll or a die-cut sheet, so it is bounded
 *  only by width. The tolerance absorbs mm↔in rounding. */
export function paperForCapability(paper: PaperSize, cap: PrinterCapability): boolean {
  if (paper.width_in > cap.maxWidthMm / MM_PER_IN + 0.05) return false;
  // Inkjet/laser feeds sheets only; thermal feeds either. Keyed on the explicit
  // media class, never the key string.
  return cap.kind === "thermal" || paper.class === "sheet";
}
export function papersForPrinter(cap: PrinterCapability): PaperSize[] {
  return PAPER_SIZES.filter((p) => paperForCapability(p, cap));
}
/** Built-in label sizes a printer can actually run. */
export function labelSizesForPrinter(cap: PrinterCapability): LabelSize[] {
  const keys = new Set(papersForPrinter(cap).map((p) => p.key));
  return LABEL_SIZES.filter((s) => keys.has(s.paper));
}
/** Whether a custom size (media width, inches) fits the printer. */
export function customWidthFits(mediaWIn: number, cap: PrinterCapability): boolean {
  if (cap.kind === "inkjet-laser") return true;
  return mediaWIn <= cap.maxWidthMm / MM_PER_IN + 0.05;
}

/** A loaded-media preset for the inline printer config: a width×height (mm) and
 *  "labels across", tappable to set the printer's media in one go. */
export interface SizePreset {
  key: string;
  /** Media width, mm. */
  w: number;
  /** Media height, mm. */
  h: number;
  /** Faces across the media (n-up); 1 for a plain roll. */
  across: number;
  /** Where it came from, for a tooltip ("from Shop Rollo"); absent for the
   *  platform library. */
  from?: string;
}

/** One-tap loaded-media presets for a printer, DERIVED from what the workspace
 *  actually uses rather than a hardcoded catalog — the "you've done this before"
 *  presets the author asked for. In priority order, deduped, and filtered to what the
 *  printer can feed:
 *   1. layouts already set up on OTHER printers (their media + labels-across),
 *   2. the workspace's own custom label sizes,
 *   3. the platform's funnel-filtered label library (`labelSizesForPrinter`) as a
 *      baseline, so a fresh workspace with one printer still gets useful taps.
 *  There is no parallel hardcoded size list: (3) is the same canonical library
 *  every other size surface funnels, so the platform stays consistent. */
export function presetsForPrinter(
  cap: PrinterCapability,
  opts: {
    otherPrinters?: { name: string; settings?: Record<string, unknown> | null }[];
    customSizes?: { name: string; media_w: number; media_h: number; label_w: number }[];
  } = {},
): SizePreset[] {
  const out: SizePreset[] = [];
  const seen = new Set<string>();
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const push = (w: number, h: number, across: number, from?: string) => {
    if (!(w >= 1) || !(h >= 1)) return;
    if (!customWidthFits(w / MM_PER_IN, cap)) return;
    const a = Math.max(1, Math.round(across || 1));
    const key = `${round1(w)}x${round1(h)}x${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, w: round1(w), h: round1(h), across: a, from });
  };
  // 1. Sizes already configured on OTHER printers — "you've done this before".
  for (const p of opts.otherPrinters ?? []) {
    const s = (p.settings ?? {}) as Record<string, unknown>;
    const m = (s.media ?? null) as { widthMm?: number; heightMm?: number } | null;
    const l = (s.label ?? null) as { widthMm?: number } | null;
    if (m?.widthMm && m?.heightMm) push(m.widthMm, m.heightMm, l?.widthMm ? m.widthMm / l.widthMm : 1, p.name);
  }
  // 2. The workspace's own custom label sizes (inches → mm).
  for (const c of opts.customSizes ?? []) {
    push(c.media_w * MM_PER_IN, c.media_h * MM_PER_IN, c.label_w ? c.media_w / c.label_w : 1, c.name);
  }
  // 3. The platform library, funnel-filtered — the same list every surface uses.
  for (const s of labelSizesForPrinter(cap)) push(s.label_w * MM_PER_IN, s.label_h * MM_PER_IN, 1);
  return out.slice(0, 8);
}

/** Items per physical sheet for a label size. */
export function perSheet(size: LabelSize): number {
  return size.cols * size.rows;
}

/** The most columns/rows of a label that fit on a paper, given margins + gaps.
 *
 *  This is the arithmetic that lets a size be defined by DIMENSIONS instead of a
 *  hardcoded col×row grid: N labels need (N-1) gaps, so
 *  `N ≤ (available + gap) / (label + gap)`. Proven against every preset in
 *  label-sizes.test.ts — the hand-tuned registry values ARE the max-fit, so
 *  deriveGrid reproduces them exactly. See
 *  docs/design-decisions/label-media-and-accumulation.md D2.
 *
 *  The 1e-9 nudge matches the float-dust tolerance sizes.test.ts already uses: a
 *  clean fit like 10.2/1.7 can land at 5.9999999 in binary and floor to the wrong
 *  count without it. */
export function deriveGrid(opts: {
  paper_w: number;
  paper_h: number;
  label_w: number;
  label_h: number;
  margin_t: number;
  margin_l: number;
  col_gap: number;
  row_gap: number;
}): { cols: number; rows: number } {
  const fit = (avail: number, label: number, gap: number): number =>
    label <= 0 ? 0 : Math.max(0, Math.floor((avail + gap + 1e-9) / (label + gap)));
  return {
    cols: fit(opts.paper_w - 2 * opts.margin_l, opts.label_w, opts.col_gap),
    rows: fit(opts.paper_h - 2 * opts.margin_t, opts.label_h, opts.row_gap),
  };
}

/** Build a LabelSize from DIMENSIONS, deriving the col×row grid — the free-form
 *  path a user-defined size takes (no hardcoded cols/rows). An explicit
 *  `cols`/`rows` overrides the derived max ONLY downward (a deliberate under-fill,
 *  e.g. 2-up on a sheet that fits 4); it is clamped so a size can never claim more
 *  labels than physically fit. `paper` must resolve, else the derived grid is
 *  0×0 and the caller shows the unknown-paper state. */
export function makeLabelSize(input: {
  key: string;
  label: string;
  paper: string;
  label_w: number;
  label_h: number;
  margin_t?: number;
  margin_l?: number;
  col_gap?: number;
  row_gap?: number;
  cols?: number;
  rows?: number;
}): LabelSize {
  const paper = findPaper(input.paper);
  const margin_t = input.margin_t ?? 0;
  const margin_l = input.margin_l ?? 0;
  const col_gap = input.col_gap ?? 0;
  const row_gap = input.row_gap ?? 0;
  const max = paper
    ? deriveGrid({ paper_w: paper.width_in, paper_h: paper.height_in, label_w: input.label_w, label_h: input.label_h, margin_t, margin_l, col_gap, row_gap })
    : { cols: 0, rows: 0 };
  return {
    key: input.key,
    label: input.label,
    paper: input.paper,
    label_w: input.label_w,
    label_h: input.label_h,
    margin_t,
    margin_l,
    col_gap,
    row_gap,
    cols: input.cols != null ? Math.min(input.cols, max.cols) : max.cols,
    rows: input.rows != null ? Math.min(input.rows, max.rows) : max.rows,
  };
}

/** A workspace-defined size (dimensions) as the (PaperSize, LabelSize) pair the
 *  CLIENT renderer (renderPrintSheetHtml) wants, with the grid derived. The
 *  media becomes a synthetic PaperSize; the `custom:<id>` key names both. Mirrors
 *  the server's buildCustomLabelSheet so the ⌘P sheet and the CUPS PDF agree. */
export function customSizeToLayout(row: {
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
}): { size: LabelSize; paper: PaperSize } {
  const key = `custom:${row.id}`;
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
    // A user-defined size is treated as a roll (its own media, tiled as chosen);
    // class is unused by the renderer but keeps it a valid PaperSize.
    paper: { key, label: row.name, width_in: row.media_w, height_in: row.media_h, class: "roll" as const },
    size: {
      key,
      label: row.name,
      paper: key,
      label_w: row.label_w,
      label_h: row.label_h,
      margin_t: row.margin_t,
      margin_l: row.margin_l,
      col_gap: row.col_gap,
      row_gap: row.row_gap,
      cols: g.cols,
      rows: g.rows,
    },
  };
}

/** Which inner layout a label cell uses, from its aspect ratio.
 *  pickLayout():
 *   • portrait — tall cells: title on top, QR pinned below
 *   • square   — roughly 1:1: title on top, QR fills the rest
 *   • row      — wide cells: QR on the left, text on the right       */
export type CellLayout = "row" | "portrait" | "square";

/** Pick a cell layout from raw width/height in ANY consistent unit (inches on
 *  the web side, points in the PDF renderer). The ONE aspect-threshold rule, so
 *  the preview and every renderer agree on a label's layout. A renderer that
 *  applied its own thresholds made the preview lie about the print: a ~2.2×2.0
 *  custom label (aspect 1.1) previewed `square` but the PDF drew it `row`, with a
 *  very different QR size. Share this and they can't diverge. */
export function pickCellLayout(w: number, h: number): CellLayout {
  const aspect = w / h;
  if (aspect <= 0.85) return "portrait";
  if (aspect < 1.2) return "square";
  return "row";
}

export function cellLayout(size: LabelSize): CellLayout {
  return pickCellLayout(size.label_w, size.label_h);
}

/** The QR's printed side, in INCHES, for a label — the single source of truth
 *  shared by the ⌘P/preview renderer (renderPrintSheet) and the preview's
 *  scannability read (print/qr-overlay assessScannability), so "how big the QR
 *  prints" and "will it scan" can never drift apart. Mirrors the per-layout
 *  geometry the sheet HTML draws: a row label gives the QR the cell height less
 *  padding; portrait ~86% of the width; square 70% of the shorter side. */
export function qrSideForLabel(size: LabelSize): number {
  const layout = cellLayout(size);
  if (layout === "row") return Math.max(0.1, size.label_h - 0.14);
  if (layout === "portrait") return 0.86 * size.label_w;
  return Math.min(size.label_w, size.label_h) * 0.7;
}
