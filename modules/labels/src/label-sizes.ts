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
    label: across > 1 ? `${wMm} × ${hMm} mm - ${across} up (${Math.round(wMm / across)} × ${hMm} mm each)` : `${wMm} × ${hMm} mm - 1 up`,
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
  { key: "letter", label: 'US Letter - 8.5 × 11"', width_in: 8.5, height_in: 11, class: "sheet" },
  { key: "roll-4x6", label: 'Label roll - 4 × 6"', width_in: 4, height_in: 6, class: "roll" },
  // Die-cut square stock fed straight through a roll printer's adjustable
  // guide. One label per feed, so no cutting: the alternative to tiling
  // squares onto 4×6 and chopping them up.
  { key: "roll-1.5", label: 'Label roll - 1½ × 1½"', width_in: 1.5, height_in: 1.5, class: "roll" },
  { key: "roll-2", label: 'Label roll - 2 × 2"', width_in: 2, height_in: 2, class: "roll" },
  ...METRIC_ROLLS.map((r) => rollMedia(r.w, r.h)),
];

// Layouts are validated against their paper: margin_l*2 + cols*label_w
// + (cols-1)*col_gap must fit width_in, likewise for height.
export const LABEL_SIZES: LabelSize[] = [
  // ── 4×6" label roll — zero margins, zero gaps (continuous media) ──
  { key: "roll-2x2", label: '2 × 2" square - 6 up', paper: "roll-4x6", label_w: 2, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 3 },
  { key: "roll-2x3", label: '2 × 3" portrait - 4 up', paper: "roll-4x6", label_w: 2, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 2, rows: 2 },
  { key: "roll-4x2", label: '4 × 2" banner - 3 up', paper: "roll-4x6", label_w: 4, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 3 },
  { key: "roll-4x3", label: '4 × 3" - 2 up', paper: "roll-4x6", label_w: 4, label_h: 3, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 2 },
  { key: "roll-4x6", label: '4 × 6" - 1 up', paper: "roll-4x6", label_w: 4, label_h: 6, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },
  // 2 across leaves 1" over on a 4" web, so centre it (½" each side) rather
  // than crowding one edge; the cut lines then sit where a guillotine can
  // take the whole stack in two passes.
  { key: "roll-1.5x1.5", label: '1½ × 1½" square - 8 up', paper: "roll-4x6", label_w: 1.5, label_h: 1.5, margin_t: 0, margin_l: 0.5, col_gap: 0, row_gap: 0, cols: 2, rows: 4 },

  // ── Die-cut square rolls — one label per feed, nothing to cut ──
  { key: "roll15-1up", label: '1½ × 1½" square - 1 up', paper: "roll-1.5", label_w: 1.5, label_h: 1.5, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },
  { key: "roll2-1up", label: '2 × 2" square - 1 up', paper: "roll-2", label_w: 2, label_h: 2, margin_t: 0, margin_l: 0, col_gap: 0, row_gap: 0, cols: 1, rows: 1 },

  // ── Metric thermal rolls (50×30, 40×30, …) — 1-up, plus 2-up where it fits ──
  ...METRIC_ROLLS.flatMap((r) => r.across.map((a) => rollLabel(r.w, r.h, a))),

  // ── US Letter — laser/inkjet sheet ──
  { key: "letter-2x2", label: '2 × 2" square - 20 up', paper: "letter", label_w: 2, label_h: 2, margin_t: 0.5, margin_l: 0.25, col_gap: 0, row_gap: 0, cols: 4, rows: 5 },
  { key: "letter-3x3", label: '3 × 3" square - 6 up', paper: "letter", label_w: 3, label_h: 3, margin_t: 0.5, margin_l: 0.5, col_gap: 0.5, row_gap: 0.25, cols: 2, rows: 3 },
  { key: "letter-4x2", label: '4 × 2" banner - 5 up', paper: "letter", label_w: 4, label_h: 2, margin_t: 0.5, margin_l: 2.25, col_gap: 0, row_gap: 0, cols: 1, rows: 5 },
  { key: "avery-5160", label: 'Avery 5160 - 1 × 2⅝" address · 30 up', paper: "letter", label_w: 2.625, label_h: 1, margin_t: 0.5, margin_l: 0.1875, col_gap: 0.125, row_gap: 0, cols: 3, rows: 10 },
  { key: "avery-22805", label: 'Avery 22805 - 1½ × 1½" square · 24 up', paper: "letter", label_w: 1.5, label_h: 1.5, margin_t: 0.5, margin_l: 0.7799, col_gap: 0.3132, row_gap: 0.2, cols: 4, rows: 6 },
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
/** A device record as the bridge reported it. Deliberately open: the bridge
 *  sends everything it knows about the machine, and each consumer reads the
 *  keys it needs. Narrowing this to today's field is what turned every new
 *  requirement into a release on both sides. */
export interface BridgeDeviceRecord {
  id?: string;
  name?: string;
  state?: string;
  media?: {
    widthDots?: number;
    widthMm?: number;
    dpi?: number;
    labelHeightMm?: number;
    gapMm?: number;
    protocol?: string;
  };
}

interface BridgeSettings {
  instance?: string;
  driver?: string;
  bridgeUrl?: string;
  device?: BridgeDeviceRecord;
}

export type PrinterKind = "inkjet-laser" | "thermal";
export interface PrinterCapability {
  kind: PrinterKind;
  maxWidthMm: number;
}

/** Evidence, in a printer's saved settings, that it runs a ROLL rather than
 *  sheets — regardless of which driver carries it.
 *
 *  This is deliberately not a list of driver names. That list was wrong three
 *  times running: first it knew only `browser-bluetooth`, so a serial-connected
 *  roll printer funnelled to sheet media; then it learned `browser-serial`, and
 *  an edge-bridged one (nominally `cups`, because the bridge is a TRANSPORT and
 *  not a driver kind) funnelled to sheet media too — a 50mm label printer
 *  offering "US Letter 8.5 x 11, 2x2 square, 20 up". Each fix taught it one more
 *  name and left the next transport to fail the same way.
 *
 *  A label printer cannot be configured without label geometry, so the geometry
 *  is the signal. Any new transport is covered the day it is added, without
 *  touching this file. */
function looksThermal(s: Record<string, unknown>): boolean {
  if (s.printerKind === "thermal") return true;
  const bridge = s.bridge as BridgeSettings | null | undefined;
  // A bridge reports what kind of machine it is fronting; `thermal` is a roll.
  if (bridge?.driver === "thermal") return true;
  // ...and a device that reports label geometry is a label printer, whatever
  // anyone called its driver.
  if (bridge?.device?.media?.widthMm || bridge?.device?.media?.widthDots) return true;
  // Roll calibration only exists on a printer that runs a roll.
  return Number(s.widthDots) > 0 || !!s.profileId || !!(s.media as { feed?: unknown } | null)?.feed;
}

/** Settings with the bridge's driver kind filled in from what the bridge says,
 *  for a printer saved before that kind was recorded.
 *
 *  Those rows carry an instance and an address and nothing that identifies a
 *  roll printer, so they funnel to sheet media — which is how a 40mm label
 *  printer opened on US Letter. Rewriting them would need a migration that
 *  could only run where the bridge is reachable, which is the browser; asking
 *  the bridge costs one call and heals the row wherever it is used. Anything
 *  already recorded wins, so this can never override a real setting. */
export function healedSettings(
  settings: Record<string, unknown> | null | undefined,
  instanceInfo: Record<string, { driver: string; device?: BridgeDeviceRecord }>,
): Record<string, unknown> | null {
  const s = settings ?? null;
  if (!s) return s;
  const bridge = s.bridge as BridgeSettings | undefined;
  if (!bridge?.instance) return s;
  const info = instanceInfo[bridge.instance];
  if (!info) return s;
  // driver: stored wins — it is intent someone may have set. device: LIVE wins —
  // the stored copy is a cache of the same source, and letting it win pinned a
  // recalibrated bridge to its old width forever. A width the USER set wins over
  // both anyway, via maxWidthMm in printerCapability.
  const driver = bridge.driver ?? info.driver;
  const device = info.device ?? bridge.device;
  if (driver === bridge.driver && device === bridge.device) return s;
  return { ...s, bridge: { ...bridge, driver, device } };
}

/** A printer's media capability, from its saved settings (falling back to the
 *  driver only for the browser transports, which always hold a roll printer).
 *  A network manager can't report its own media, so a sheet printer is the
 *  default — but see looksThermal: anything carrying roll geometry says so. */
export function printerCapability(
  driver: string,
  settings?: Record<string, unknown> | null,
): PrinterCapability {
  const s = settings ?? {};
  const browserRadio = driver === "browser-bluetooth" || driver === "browser-serial";
  if (browserRadio || looksThermal(s)) {
    const max =
      Number(s.maxWidthMm) ||
      // What the bridge reported about the device itself. The operator set this
      // to make the printer work at all, so it beats any guess.
      Number((s.bridge as BridgeSettings | null | undefined)?.device?.media?.widthMm) ||
      (Number(s.widthDots) ? Number(s.widthDots) / 8 : 0) ||
      // Last resort, and deliberately the NARROW end of the label-printer
      // range: too narrow only hides sizes someone can still pick on purpose,
      // while too wide offers media the printer cannot feed and ruins a label.
      // Guess toward the recoverable mistake.
      //
      // A known model's width is NOT consulted here, and does not need to be.
      // A browser-paired printer stores maxWidthMm from its profile when it is
      // paired, and a bridged one reports its real head width — which is better
      // than the table anyway (the table says 54mm for a PM240; the bridge says
      // the 40mm it is actually calibrated for). Reaching for the profile
      // package from here dragged the Bluetooth encoder into the API's module
      // mount and took the Labels page down in production.
      54;
    return { kind: "thermal", maxWidthMm: max };
  }
  return { kind: "inkjet-laser", maxWidthMm: Number(s.maxWidthMm) || 216 };
}

/** How much wider than the PRINTABLE head a roll's nominal width may be.
 *
 *  A roll is sold by its liner width; the head prints less than that. The PM220S
 *  reports a 48 mm head (384 dots at 203 dpi) and the stock everyone runs on it
 *  is labelled 50 mm. With only a rounding tolerance (1.27 mm) that roll counted
 *  as too wide for the printer it ships with, so the size was never offered — and
 *  a remembered choice of it was blanked on every load, which is how a printer
 *  with 50x30 2-up stored on its row opened on "Pick media...".
 *
 *  3 mm covers the liner without becoming a licence: a 54 mm paper is still
 *  refused by a 48 mm head, and 4x6 still is, which is the case the narrow
 *  tolerance existed for. */
const LINER_OVERHANG_MM = 3;

/** The max width is the real constraint — nothing wider than the printer can feed.
 *  Beyond that, an inkjet/laser feeds SHEETS only (it can't take a thermal roll),
 *  while a thermal printer runs either a roll or a die-cut sheet, so it is bounded
 *  only by width. The extra tolerance absorbs mm↔in rounding. */
export function paperForCapability(paper: PaperSize, cap: PrinterCapability): boolean {
  if (paper.width_in > (cap.maxWidthMm + LINER_OVERHANG_MM) / MM_PER_IN + 0.05) return false;
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
/** The media + layout matching a roll the printer itself reported, in mm.
 *
 *  A coded roll tells the printer its own size, so the person should not have to
 *  tell Cobblr a second time — and until this existed they could not even be
 *  right by accident: the printer's reading was rendered as a sentence and
 *  discarded, so a 40 x 30 roll sat behind a US Letter default.
 *
 *  Returns the 1-up layout: one label per feed is what a die-cut roll is FOR,
 *  and an n-up on die-cut stock prints across the gaps. Null when nothing
 *  matches, which leaves the person's own choice alone rather than snapping it
 *  to something close but wrong. */
export function mediaForReading(widthMm: number, heightMm: number): { paperKey: string; sizeKey: string } | null {
  const TOL_MM = 1; // the reading is whole mm; the registry is inches round-tripped
  const paper = PAPER_SIZES.find(
    (p) =>
      p.class === "roll" &&
      Math.abs(p.width_in * MM_PER_IN - widthMm) <= TOL_MM &&
      Math.abs(p.height_in * MM_PER_IN - heightMm) <= TOL_MM,
  );
  if (!paper) return null;
  const sizes = LABEL_SIZES.filter((s) => s.paper === paper.key);
  const oneUp = sizes.find((s) => s.cols === 1 && s.rows === 1) ?? sizes[0];
  return oneUp ? { paperKey: paper.key, sizeKey: oneUp.key } : null;
}

/** Whether a custom size (media width, inches) fits the printer. */
export function customWidthFits(mediaWIn: number, cap: PrinterCapability): boolean {
  if (cap.kind === "inkjet-laser") return true;
  return mediaWIn <= (cap.maxWidthMm + LINER_OVERHANG_MM) / MM_PER_IN + 0.05;
}


// presetsForPrinter lived here: it GUESSED the sizes a workspace uses by reading
// the media configured on other printers. Every print now records lastSizeKey +
// lastUsedAt on the printer it went to, so recentSizeKeys (printer-memory.ts)
// reads the real history instead of inferring it, and the guess is retired.

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

/** Whether the "Rotate 90°" (print portrait) toggle applies to a label of these
 *  cell dimensions. ONLY a LANDSCAPE face (wider than tall — a `row` cell)
 *  benefits: a quarter turn makes it read portrait. A portrait cell is already
 *  portrait and a square is unchanged, so rotating them is pointless — and for a
 *  portrait cell actively BROKEN: the 2-up 50×30 has 25×30 portrait cells, and
 *  turning one landscape (30×25, nearly square) left the QR filling it with the
 *  caption overflowing off the label (the author, 2026-07). Gate the toggle on this so it
 *  only appears where it helps. */
export function labelRotatable(labelW: number, labelH: number): boolean {
  return pickCellLayout(labelW, labelH) === "row";
}

/** Whether a label of these cell dimensions should print TURNED by default.
 *
 *  Derived from the row layout's own geometry rather than a tuned constant. A
 *  `row` cell puts the QR on the left as a square of the cell HEIGHT, so the
 *  caption is left with roughly `w - h` of width. Turning the cell makes it
 *  portrait: the title then spans the face, giving the caption `h`. So turning
 *  wins exactly when
 *
 *      h > w - h        i.e.   w / h < 2
 *
 *  and the crossover is aspect 2 with nothing to tune. The QR barely changes
 *  size across the turn (row gives it h - 0.14in, portrait gives it 0.86w of
 *  the turned face), so this is close to free width for the text.
 *
 *  Worked against every stock size: a 40x30 roll goes from a 10mm caption
 *  column to 30mm (it was wrapping "Thumper" to "Th/um/per" and truncating
 *  "Prusa MINI+"), 50x30 from 20mm to 30mm. A 40x20 and a 4x2 banner sit
 *  exactly at 2 — a wash, so they are left alone — and an address label like
 *  Avery 5160 (aspect 2.6) keeps its natural horizontal reading.
 *
 *  Only ever true where the turn toggle applies at all (see labelRotatable): a
 *  portrait or square cell is never turned. */
export function shouldAutoRotate(labelW: number, labelH: number): boolean {
  if (!labelRotatable(labelW, labelH)) return false;
  return labelH > labelW - labelH;
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
