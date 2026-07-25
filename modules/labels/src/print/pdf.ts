// Server-side label sheet rendering. Produces a PDF Buffer that
// matches the browser preview closely enough to be sent directly to
// CUPS without going through window.print() in the user's browser.
//
// Layout mirrors LabelPrintPage.tsx — title centered above QR for
// column-style cells, QR-left / title+description right for row-style.
// QR codes embed a high-error-correction code with an optional white
// circle + centered number overlay, same as the in-app QrWithCenter
// component. Cell-border lines are solid black so they actually show
// up on the Rollo's 1-bit thermal output (light greys disappear).

import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont } from "pdf-lib";
import QRCode from "qrcode";
import { findSize, type LabelSheet } from "./layout.js";
import { packShelvesBigFirst } from "./pack.js";
import { computeCapsule, validateOverlay } from "./qr-overlay.js";
import { pickCellLayout, type CellLayout } from "../label-sizes.js";
// Shared label geometry — the same box the preview and the Bluetooth raster use.
// It lives in platform-contract precisely so this SERVER renderer can reach it.
import { captionBox, RENDER_LINE, MARGIN_FRAC, SIDE_MARGIN_FRAC } from "@cobblr/platform-contract/label-geometry";

/** A label whose center code would make its QR hard/impossible to scan. The
 *  render still emits the label; the caller surfaces these so the user can
 *  shorten the code or pick a larger size before committing a bad batch. */
export interface LabelWarning {
  kind: string;
  id: number;
  code: string;
  reason: string;
  coveredFraction: number;
}

export interface PrintItem {
  /** Source entity kind — only used in error messages, so any string. */
  kind: string;
  id: number;
  /** Title rendered above (column) or to the right of (row) the QR. */
  title: string;
  /** Absolute URL the QR encodes. */
  url: string;
  /** Optional digit to overlay inside the QR. */
  centerCode?: string;
  /** Optional multi-line note shown under title in row layouts. */
  description?: string;
  /** Per-item preset key. When set, overrides the request's default
   *  size_key for this item, enabling mixed-size packing on one sheet
   *  (only on continuous-roll paper — Avery presets reject mixing). */
  sizeKey?: string;
}

const PT = 72; // 72pt = 1in

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Render QR to a PNG buffer with optional white-circle + digit overlay
// in the centre. ErrorCorrection H gives ~30% redundancy so the
// overlay doesn't break scannability.
async function qrPng(payload: string, _centerCode?: string): Promise<Buffer> {
  const png = await QRCode.toBuffer(payload, {
    errorCorrectionLevel: "H",
    type: "png",
    margin: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
    width: 600,
  });
  // The overlay (white circle + centered code) is drawn at PDF time
  // in drawCenterOverlay so the QR pixels stay untouched — we keep
  // the EC=H redundancy budget for the obscured area.
  return png;
}

// The web embeds U+2192 ("→") as the room/area separator on titles.
// pdf-lib's standard Helvetica is Latin-1 only and can't measure or
// draw it, so the server treats → as a virtual glyph: a fixed pixel
// width for layout, a hand-drawn chevron at render time.
const ARROW = "→";
function arrowWidth(fontSize: number): number { return fontSize * 0.95; }

// Width of `text` at `size`, treating any → characters as a virtual
// glyph of `arrowWidth(size)` so callers don't trip Helvetica's
// Latin-1 limitation.
function measureText(font: PDFFont, text: string, size: number): number {
  if (!text.includes(ARROW)) return font.widthOfTextAtSize(text, size);
  const segs = text.split(ARROW);
  let w = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i]) w += font.widthOfTextAtSize(segs[i]!, size);
    if (i < segs.length - 1) w += arrowWidth(size);
  }
  return w;
}

// Like page.drawText(...), but renders → as a vector chevron arrow
// (matches the web's literal U+2192). x is the left edge; y is the
// text baseline (pdf-lib convention).
function drawTextWithArrows(
  page: PDFPage, font: PDFFont, x: number, y: number,
  size: number, color: ReturnType<typeof rgb>, text: string,
) {
  if (!text.includes(ARROW)) {
    page.drawText(text, { x, y, size, font, color });
    return;
  }
  let cx = x;
  const segs = text.split(ARROW);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg) {
      page.drawText(seg, { x: cx, y, size, font, color });
      cx += font.widthOfTextAtSize(seg, size);
    }
    if (i < segs.length - 1) {
      drawRightArrow(page, cx, y, arrowWidth(size), size);
      cx += arrowWidth(size);
    }
  }
}

// Hand-drawn thick black right-arrow at (x, baseY) with width `w`,
// sized to ride at the optical centre of `fontSize`. Three thick line
// segments — shaft + two chevron strokes — render reliably across
// pdf-lib versions without needing drawSvgPath's coordinate gymnastics.
function drawRightArrow(page: PDFPage, x: number, baseY: number, w: number, fontSize: number) {
  // Approximate centre of the cap height; baseY is the text baseline.
  const yMid = baseY + fontSize * 0.32;
  const thickness = Math.max(0.8, fontSize * 0.11);
  const headSize = fontSize * 0.34;
  const xEnd = x + w;
  // Shaft.
  page.drawLine({
    start: { x: x + thickness / 2, y: yMid },
    end: { x: xEnd - thickness / 2, y: yMid },
    thickness, color: rgb(0, 0, 0), lineCap: 1,
  });
  // Upper + lower chevron strokes that meet at the tip.
  page.drawLine({
    start: { x: xEnd - headSize, y: yMid + headSize * 0.85 },
    end: { x: xEnd, y: yMid },
    thickness, color: rgb(0, 0, 0), lineCap: 1,
  });
  page.drawLine({
    start: { x: xEnd - headSize, y: yMid - headSize * 0.85 },
    end: { x: xEnd, y: yMid },
    thickness, color: rgb(0, 0, 0), lineCap: 1,
  });
}

function wrapToLines(font: PDFFont, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (measureText(font, trial, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = trial;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    // Truncate the last line with ellipsis if there's overflow.
    const i = lines.length - 1;
    let last = lines[i]!;
    while (measureText(font, last + "…", size) > maxWidth && last.length > 1) {
      last = last.slice(0, -1);
    }
    if (words.join(" ").length > lines.join(" ").length) last = last.trimEnd() + "…";
    lines[i] = last;
  }
  return lines;
}

// Three layouts, picked from the cell's aspect ratio by the SHARED rule
// (pickCellLayout in ../label-sizes) so the PDF draws the exact layout the
// preview + ⌘P sheet showed. These used to be the PDF's own w>h / h>=1.3w
// thresholds, which disagreed with the preview for custom sizes in aspect
// 0.77–0.85 and 1.0–1.2 — the preview then lied about the print. Aspect is
// unit-independent, so passing points here matches the preview's inches.
//   row      — wide:  QR left, [title + description] right.
//   portrait — tall:  [title + description] top half, QR bottom half.
//   square   — ~1:1:  title centred on top, QR fills rest.
type LabelLayout = CellLayout;
const pickLayout = (w: number, h: number): LabelLayout => pickCellLayout(w, h);

/** Which sides of a label cell get a hairline cut guide. Empty / false
 *  sides are skipped so the outer paper edge (and any other edge we
 *  don't want a line at) renders cleanly. */
export interface CellBorders { top: boolean; right: boolean; bottom: boolean; left: boolean }
const ALL_CELL_BORDERS: CellBorders = { top: true, right: true, bottom: true, left: true };

/** The cut-guide dedup: on a grid of ABUTTING cells (no gap), every internal
 *  separator must be drawn EXACTLY ONCE, or it prints as a doubled/heavier
 *  hairline. Each cell owns only the edges no neighbour already draws:
 *    · top    — owned by the lower cell, so drawn unless this is the top row
 *               (a margin still wants the outer line);
 *    · left   — owned by the right cell, so drawn unless this is the left column;
 *    · right  — only the outer paper edge (with a margin), or the seam next to an
 *               EMPTY neighbour (a short last row leaves a gap that wants a line);
 *    · bottom — only on the last rendered row.
 *  With a gap between cells there is no shared edge, so every cell is fully
 *  bordered (ALL_CELL_BORDERS). Pure + exported so this exact behaviour is locked
 *  by test (modules/labels/tests/print-milestone.test.ts) and cannot silently
 *  regress when the size model changes.
 */
export function computeCellBorders(opts: {
  ci: number;
  cols: number;
  cellCount: number;
  cellsAbut: boolean;
  marginT: number;
  marginL: number;
}): CellBorders {
  const { ci, cols, cellCount, cellsAbut, marginT, marginL } = opts;
  if (!cellsAbut) return ALL_CELL_BORDERS;
  const col = ci % cols;
  const row = Math.floor(ci / cols);
  const lastRenderedRow = cellCount > 0 ? Math.floor((cellCount - 1) / cols) : -1;
  const rightCellFilled =
    col < cols - 1 && ci + 1 < cellCount && Math.floor((ci + 1) / cols) === row;
  return {
    top: row > 0 || marginT > 0,
    left: col > 0 || marginL > 0,
    right: (col === cols - 1 && marginL > 0) || (col < cols - 1 && !rightCellFilled),
    bottom: row === lastRenderedRow,
  };
}

async function placeLabel(
  page: PDFPage, doc: PDFDocument, font: PDFFont, boldFont: PDFFont,
  item: PrintItem, x: number, y: number, w: number, h: number,
  borders: CellBorders = ALL_CELL_BORDERS,
  warnings?: LabelWarning[],
) {
  // 0.75pt hairline cut guides on the requested sides. Was 1.5pt
  // earlier (to fight anti-aliased grey on the Rollo's 1-bit head)
  // but the author confirmed the thinner line prints fine, so we're back to
  // the lighter weight. drawLine per side instead of drawRectangle so
  // edges at the paper boundary can be skipped without redrawing.
  const lw = 0.75;
  const col = rgb(0, 0, 0);
  if (borders.top)    page.drawLine({ start: { x, y: y + h }, end: { x: x + w, y: y + h }, thickness: lw, color: col });
  if (borders.bottom) page.drawLine({ start: { x, y },       end: { x: x + w, y },         thickness: lw, color: col });
  if (borders.left)   page.drawLine({ start: { x, y },       end: { x, y: y + h },         thickness: lw, color: col });
  if (borders.right)  page.drawLine({ start: { x: x + w, y }, end: { x: x + w, y: y + h }, thickness: lw, color: col });

  const layout = pickLayout(w, h);
  // Cell padding, SPLIT BY AXIS. A roll wanders laterally in the feed path while
  // the gap sensor holds it straight down the feed, so the sides need more
  // clearance than the top and bottom — the same asymmetry the browser renderers
  // use, scaled by the same ratio so the three stay in step. padY is unchanged
  // from the symmetric value, so nothing about the vertical layout moves.
  const padY = 0.08 * PT;
  const padX = padY * (SIDE_MARGIN_FRAC / MARGIN_FRAC);
  const png = await qrPng(item.url, item.centerCode);
  const qrImg = await doc.embedPng(png);

  // Draw the center code (if any) at the QR's position/size and record a
  // warning when the overlay would push the QR past its scannable budget.
  function overlay(ox: number, oy: number, size: number) {
    if (item.centerCode == null) return;
    const v = drawCenterOverlay(page, boldFont, ox, oy, size, item.centerCode, item.url);
    if (!v.safe && warnings) {
      warnings.push({ kind: item.kind, id: item.id, code: item.centerCode, reason: v.reason ?? "QR not scannable", coveredFraction: v.coveredFraction });
    }
  }

  // Draw a multi-line block of centered text starting at top baseline.
  // Returns the bottom Y (where the next thing should start).
  function drawCenteredBlock(lines: string[], topY: number, size: number, fontUsed: PDFFont, color: ReturnType<typeof rgb>): number {
    let cursorY = topY;
    for (const line of lines) {
      const lineW = measureText(fontUsed, line, size);
      drawTextWithArrows(page, fontUsed, x + (w - lineW) / 2, cursorY, size, color, line);
      cursorY -= size * 1.1;
    }
    return cursorY;
  }

  if (layout === "row") {
    // QR on the left, text on the right.
    const qrSize = h - 2 * padY;
    const qrX = x + padX;
    const qrY = y + padY;
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    overlay(qrX, qrY, qrSize);

    const textX = qrX + qrSize + 0.04 * PT;
    const textW = x + w - padX - textX;
    if (textW > 4) {
      const titleSize = titleSizeFor(boldFont, w, h, item.title);
      const titleLines = wrapToLines(boldFont, item.title, titleSize, textW, 2);
      let cursorY = y + h - padY - titleSize;
      for (const line of titleLines) {
        drawTextWithArrows(page, boldFont, textX, cursorY, titleSize, rgb(0, 0, 0), line);
        cursorY -= titleSize * 1.1;
      }
      if (item.description && h >= 1.3 * PT) {
        const descSize = Math.max(10, titleSize * 0.85);
        const descLines = wrapToLines(font, item.description, descSize, textW, 6);
        cursorY -= 0.04 * PT;
        for (const line of descLines) {
          drawTextWithArrows(page, font, textX, cursorY, descSize, rgb(0, 0, 0), line);
          cursorY -= descSize * 1.15;
          if (cursorY < y + padY) break;
        }
      }
    }
  } else if (layout === "portrait") {
    // Top half: title at TOP (so titles line up across cells), then
    // description flowing below. Bottom half: QR pinned to the top of
    // the bottom half (top edge on the cell's midline), with a bottom
    // margin so it never butts up against the cut line.
    const halfH = h / 2;
    const topMargin = 0.12 * PT;     // breathing room from the cell top
    const bottomMargin = 0.12 * PT;  // breathing room from the cell bottom
    const titleSize = titleSizeFor(boldFont, w, h, item.title);
    const titleLines = wrapToLines(boldFont, item.title, titleSize, w - 2 * padX, 2);
    const titleTop = y + h - topMargin - titleSize;
    let cursorY = drawCenteredBlock(titleLines, titleTop, titleSize, boldFont, rgb(0, 0, 0));
    if (item.description) {
      const descSize = Math.max(9, titleSize * 0.8);
      const descLines = wrapToLines(font, item.description, descSize, w - 2 * padX, 8);
      cursorY -= 0.04 * PT;
      for (const line of descLines) {
        if (cursorY < y + halfH + padY) break; // never bleed into QR half
        const lineW = measureText(font, line, descSize);
        drawTextWithArrows(page, font, x + (w - lineW) / 2, cursorY, descSize, rgb(0, 0, 0), line);
        cursorY -= descSize * 1.15;
      }
    }
    // QR: top edge at the midline (y + halfH), bottom edge at
    // y + bottomMargin. Square, fits width and height. Centered horizontally.
    const qrSize = Math.min(w - 2 * padX, halfH - bottomMargin);
    const qrX = x + (w - qrSize) / 2;
    const qrY = y + halfH - qrSize; // top of QR at the midline
    // Push QR DOWN if there's slack between qrSize and the available
    // half-height (qrSize was capped by width). Anchor to bottomMargin.
    const qrYBottomAnchored = Math.max(y + bottomMargin, qrY);
    page.drawImage(qrImg, { x: qrX, y: qrYBottomAnchored, width: qrSize, height: qrSize });
    overlay(qrX, qrYBottomAnchored, qrSize);
  } else {
    // Square / squarish: title at top, QR centred in remaining. Title
    // keeps the fixed (single-line) font size but is allowed to wrap to
    // a 2nd line — the QR is width-limited in square cells, so the
    // extra line comes out of the vertical slack above the QR rather
    // than shrinking it. `pickFontSize(..., 1)` keeps the size fixed
    // (no shrink-to-fit); `wrapToLines(..., 2)` does the wrap.
    const titleSize = titleSizeFor(boldFont, w, h, item.title, 2);
    const titleLines = wrapToLines(boldFont, item.title, titleSize, w - 2 * padX, 2);
    const titleTop = y + h - padY - titleSize;
    const cursorY = drawCenteredBlock(titleLines, titleTop, titleSize, boldFont, rgb(0, 0, 0));
    const qrTop = cursorY - 0.04 * PT;
    const qrBot = y + padY;
    const qrSize = Math.min(w - 2 * padX, qrTop - qrBot);
    const qrX = x + (w - qrSize) / 2;
    const qrY = qrBot + (qrTop - qrBot - qrSize) / 2;
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    overlay(qrX, qrY, qrSize);
  }
}

// White capsule (stadium) + black centered code overlaid on the QR. Fixed
// vertical half-height, width that grows with the code, so glyph height stays
// constant across 1-char and 5-char codes (a circle shrank both dimensions and
// smeared past ~3 chars). A 1-char code has a zero-length middle => it renders
// as a plain circle, identical to the legacy overlay. Geometry + scannability
// validation live in qr-overlay.ts; this draws the shape and returns whether
// the label will still scan (payload = the QR's own URL, so the check is
// module-count aware). Vertical centering: cap-height/2 above the baseline.
function drawCenterOverlay(
  page: PDFPage, font: PDFFont, qrX: number, qrY: number, qrSize: number,
  text: string, payload: string,
): ReturnType<typeof validateOverlay> {
  const cap = computeCapsule(qrSize, text, (t, s) => font.widthOfTextAtSize(t, s));
  const cx = qrX + cap.cx * qrSize;
  const cy = qrY + cap.cy * qrSize;
  const hh = cap.hh * qrSize;
  const hwInner = cap.hwInner * qrSize;
  const white = rgb(1, 1, 1);

  // Stadium = a rectangular middle + a semicircular cap at each end. Drawn as a
  // white rectangle plus two white circles of radius hh centered on the ends.
  if (hwInner > 0.1) {
    page.drawRectangle({ x: cx - hwInner, y: cy - hh, width: 2 * hwInner, height: 2 * hh, color: white, borderWidth: 0 });
  }
  page.drawEllipse({ x: cx - hwInner, y: cy, xScale: hh, yScale: hh, color: white, borderWidth: 0 });
  page.drawEllipse({ x: cx + hwInner, y: cy, xScale: hh, yScale: hh, color: white, borderWidth: 0 });

  const tw = font.widthOfTextAtSize(text, cap.fontSize);
  const ch = font.heightAtSize(cap.fontSize, { descender: false });
  page.drawText(text, { x: cx - tw / 2, y: cy - ch / 2, size: cap.fontSize, font, color: rgb(0, 0, 0) });

  return validateOverlay(payload, cap);
}

/** Thermal legibility floor (pt). A 1-bit thermal head turns small text to mush,
 *  so the PDF never shrinks a title past this even when the shared geometry would
 *  allow it. This is the deliberate difference from the on-screen preview, which
 *  can render 5pt cleanly; it is why a very long name on a small label prints
 *  slightly larger here than it previews. */
const THERMAL_FLOOR_PT = 9;

/** The largest font (pt) at which `text` fits `boxW`×`boxH` within `maxLines`,
 *  measured with the REAL font metrics pdf-lib provides — no glyph-width estimate
 *  needed here, unlike the browser renderers. Monotonic, so binary search. */
function fitToBox(font: PDFFont, text: string, boxW: number, boxH: number, maxLines: number): number {
  const t = text.trim();
  if (!t || boxW <= 0 || boxH <= 0) return THERMAL_FLOOR_PT;
  let lo = THERMAL_FLOOR_PT;
  let hi = Math.max(THERMAL_FLOOR_PT, boxH); // one line can never exceed the box height
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const lines = wrapToLines(font, t, mid, boxW, maxLines);
    // wrapToLines ellipsises when it runs out of lines; a truncated result is NOT
    // a fit, or "fits" would be true for a font far too large.
    const truncated = lines.some((l) => l.endsWith("…"));
    const fits =
      !truncated &&
      lines.length * mid * RENDER_LINE <= boxH &&
      lines.every((l) => measureText(font, l, mid) <= boxW);
    if (fits) lo = mid;
    else hi = mid;
  }
  return Math.max(THERMAL_FLOOR_PT, Math.round(lo * 10) / 10);
}

/** The title size for a cell: the shared captionBox geometry (so the PDF fills the
 *  same proportion of the face as the preview and the Bluetooth print), fitted with
 *  real metrics, floored for thermal. Replaces a hardcoded ladder that ignored the
 *  cell's actual free space and so ran 0.37x to 2.28x off the other renderers. */
function titleSizeFor(font: PDFFont, cellW: number, cellH: number, title: string, maxLines = 2): number {
  const box = captionBox(cellW, cellH, pickLayout(cellW, cellH));
  return fitToBox(font, title, box.fitW, box.fitH, maxLines);
}


export interface RenderInput {
  /** Default size for items without their own `sizeKey`. */
  size_key: string;
  items: PrintItem[];
  /** Workspace-defined sizes (built by buildCustomLabelSheet from the tenant's
   *  labels_custom_sizes rows). Resolved BEFORE the built-in registry, so a
   *  `custom:<id>` key finds its sheet. The route pre-fetches these because the
   *  render loop resolves keys synchronously. */
  extraSizes?: LabelSheet[];
}

export interface RenderResult {
  pdf: Buffer;
  /** Actual sheet count after packing — caller reports this in the
   *  print-direct response so the UI can show the right number. */
  sheets: number;
  /** Labels whose center code would make the QR hard/impossible to scan.
   *  Empty in the normal case. */
  warnings: LabelWarning[];
}

export async function renderLabelsPdf(input: RenderInput): Promise<RenderResult> {
  // A workspace-defined size (custom:<id>) resolves ahead of the built-in
  // registry; everything downstream treats it as any other LabelSheet.
  const resolveSize = (key: string): LabelSheet | undefined =>
    input.extraSizes?.find((s) => s.key === key) ?? findSize(key);

  const defaultSize = resolveSize(input.size_key);
  if (!defaultSize) throw new Error(`unknown size_key: ${input.size_key}`);

  // Resolve a per-item size_key: explicit override, else the default.
  const resolved = input.items.map((it) => {
    const key = it.sizeKey ?? input.size_key;
    const size = resolveSize(key);
    if (!size) throw new Error(`unknown size_key on item ${it.kind}:${it.id}: ${key}`);
    return { item: it, size };
  });

  // Decide path: if every item shares the SAME size_key AND that size
  // is a "sheet" preset (Avery, fixed positions), use the original
  // uniform-grid renderer. Otherwise — every item is on a continuous-
  // roll preset, possibly with mixed dimensions — pack the lot onto
  // shared sheets via the shelf packer.
  const allSameKey = resolved.every((r) => r.size.key === defaultSize.key);
  if (allSameKey || defaultSize.is_sheet_label) {
    if (!allSameKey) {
      // Avery with mixed sizes would mean ignoring pre-cut positions
      // — fail loudly instead of silently producing misaligned prints.
      throw new Error("Cannot mix sizes on Avery sheet labels — pre-cut positions are fixed.");
    }
    return renderUniformGrid(input.items, defaultSize);
  }
  return renderPacked(resolved, defaultSize);
}

// Uniform-grid path: every item shares the same preset. Same code as
// before; this is what /labels has always done up through Phase 1.
async function renderUniformGrid(items: PrintItem[], size: LabelSheet): Promise<RenderResult> {
  const subdivisions = size.subdivisions ?? 1;
  const perSheet = size.cols * size.rows * subdivisions;
  if (perSheet < 1) throw new Error("invalid sheet geometry");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const warnings: LabelWarning[] = [];

  const sheetWpt = size.sheet_w * PT;
  const sheetHpt = size.sheet_h * PT;
  const cellWpt = size.label_w * PT;
  const cellHpt = size.label_h * PT;
  const subWpt = cellWpt / subdivisions;
  const marginTpt = size.margin_t * PT;
  const marginLpt = size.margin_l * PT;
  const colGapPt = size.col_gap * PT;
  const rowGapPt = size.row_gap * PT;

  // Cells abut when there's no inter-cell gap — the Rollo case. In
  // that geometry we draw each shared boundary exactly once (a cell
  // owns its top + left). An edge still needs a line wherever there's
  // paper to trim beyond it:
  //   • a side/top margin (a preset inset from the roll edge),
  //   • a partially-filled final row, where a filled cell sits next
  //     to a blank one — that divider would otherwise go missing,
  //   • the bottom of the last rendered row — always, so the batch
  //     can be cut off the continuous roll.
  // Non-abutting layouts (Avery) keep all 4 sides per cell.
  const cellsAbut = size.col_gap === 0 && size.row_gap === 0;
  const pages = chunk(items, perSheet);
  for (const pageItems of pages) {
    const page = doc.addPage([sheetWpt, sheetHpt]);
    const cells = chunk(pageItems, subdivisions);
    for (let ci = 0; ci < cells.length; ci++) {
      const col = ci % size.cols;
      const row = Math.floor(ci / size.cols);
      const cellX = marginLpt + col * (cellWpt + colGapPt);
      const cellY = sheetHpt - marginTpt - (row + 1) * cellHpt - row * rowGapPt;
      const cellBorders = computeCellBorders({
        ci,
        cols: size.cols,
        cellCount: cells.length,
        cellsAbut,
        marginT: size.margin_t,
        marginL: size.margin_l,
      });
      const cellItems = cells[ci]!;
      if (subdivisions === 1) {
        if (cellItems[0]) await placeLabel(page, doc, font, boldFont, cellItems[0], cellX, cellY, cellWpt, cellHpt, cellBorders, warnings);
      } else {
        for (let si = 0; si < subdivisions; si++) {
          const it = cellItems[si];
          if (!it) continue;
          const subX = cellX + si * subWpt;
          await placeLabel(page, doc, font, boldFont, it, subX, cellY, subWpt, cellHpt, cellBorders, warnings);
        }
      }
    }
  }

  return { pdf: Buffer.from(await doc.save()), sheets: pages.length, warnings };
}

// Packed path: mixed sizes on continuous-roll sheets. Items are
// shelf-packed biggest-first, items wider/taller than the paper get
// a sheet to themselves (degenerate case).
async function renderPacked(
  resolved: Array<{ item: PrintItem; size: LabelSheet }>,
  defaultSize: LabelSheet,
): Promise<RenderResult> {
  // All items must agree on the paper dimensions — otherwise we
  // can't pack them on the same sheet. Use the default's dims.
  for (const r of resolved) {
    if (r.size.is_sheet_label) {
      throw new Error(`Mixing Avery sheet preset ${r.size.key} with packed render isn't supported.`);
    }
    if (Math.abs(r.size.sheet_w - defaultSize.sheet_w) > 1e-6 || Math.abs(r.size.sheet_h - defaultSize.sheet_h) > 1e-6) {
      throw new Error(`Preset ${r.size.key} has different paper than the request default (${defaultSize.key}).`);
    }
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const warnings: LabelWarning[] = [];

  // Shelf-pack on inch coordinates (mirrors the web preview's math).
  const packables = resolved.map((r) => ({
    w: r.size.label_w,
    h: r.size.label_h,
    item: r.item,
  }));
  const sheets = packShelvesBigFirst(packables, defaultSize.sheet_w, defaultSize.sheet_h);

  const sheetWpt = defaultSize.sheet_w * PT;
  const sheetHpt = defaultSize.sheet_h * PT;
  for (const sheet of sheets) {
    const page = doc.addPage([sheetWpt, sheetHpt]);
    for (const placement of sheet.placements) {
      // Pack returned (x, y) measured from the sheet TOP-LEFT in
      // inches. pdf-lib's y grows UP from the bottom, so flip.
      const cellWpt = placement.w * PT;
      const cellHpt = placement.h * PT;
      const cellX = placement.x * PT;
      const cellY = sheetHpt - (placement.y + placement.h) * PT;
      await placeLabel(page, doc, font, boldFont, placement.item.item, cellX, cellY, cellWpt, cellHpt, ALL_CELL_BORDERS, warnings);
    }
  }

  return { pdf: Buffer.from(await doc.save()), sheets: sheets.length, warnings };
}
