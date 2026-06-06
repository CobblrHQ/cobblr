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

// Three layouts, picked from cell aspect ratio (mirrors the web's
// pickLabelLayout in LabelPrintPage.tsx):
//   row      — w > h:           QR left, [title + description] right.
//   portrait — h >= w * 1.3:    [title + description] top half, QR bottom half.
//   square   — otherwise:       title centred on top, QR fills rest.
type LabelLayout = "row" | "portrait" | "square";
function pickLayout(w: number, h: number): LabelLayout {
  if (w > h) return "row";
  if (h >= w * 1.3) return "portrait";
  return "square";
}

/** Which sides of a label cell get a hairline cut guide. Empty / false
 *  sides are skipped so the outer paper edge (and any other edge we
 *  don't want a line at) renders cleanly. */
interface CellBorders { top: boolean; right: boolean; bottom: boolean; left: boolean }
const ALL_CELL_BORDERS: CellBorders = { top: true, right: true, bottom: true, left: true };

async function placeLabel(
  page: PDFPage, doc: PDFDocument, font: PDFFont, boldFont: PDFFont,
  item: PrintItem, x: number, y: number, w: number, h: number,
  borders: CellBorders = ALL_CELL_BORDERS,
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
  const pad = 0.08 * PT;
  const png = await qrPng(item.url, item.centerCode);
  const qrImg = await doc.embedPng(png);

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
    const qrSize = h - 2 * pad;
    const qrX = x + pad;
    const qrY = y + pad;
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    if (item.centerCode != null) drawCenterOverlay(page, boldFont, qrX, qrY, qrSize, item.centerCode);

    const textX = qrX + qrSize + 0.04 * PT;
    const textW = x + w - pad - textX;
    if (textW > 4) {
      const titleSize = pickFontSize(w, h, item.title);
      const titleLines = wrapToLines(boldFont, item.title, titleSize, textW, 2);
      let cursorY = y + h - pad - titleSize;
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
          if (cursorY < y + pad) break;
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
    const titleSize = pickFontSize(w, h, item.title);
    const titleLines = wrapToLines(boldFont, item.title, titleSize, w - 2 * pad, 2);
    const titleTop = y + h - topMargin - titleSize;
    let cursorY = drawCenteredBlock(titleLines, titleTop, titleSize, boldFont, rgb(0, 0, 0));
    if (item.description) {
      const descSize = Math.max(9, titleSize * 0.8);
      const descLines = wrapToLines(font, item.description, descSize, w - 2 * pad, 8);
      cursorY -= 0.04 * PT;
      for (const line of descLines) {
        if (cursorY < y + halfH + pad) break; // never bleed into QR half
        const lineW = measureText(font, line, descSize);
        drawTextWithArrows(page, font, x + (w - lineW) / 2, cursorY, descSize, rgb(0, 0, 0), line);
        cursorY -= descSize * 1.15;
      }
    }
    // QR: top edge at the midline (y + halfH), bottom edge at
    // y + bottomMargin. Square, fits width and height. Centered horizontally.
    const qrSize = Math.min(w - 2 * pad, halfH - bottomMargin);
    const qrX = x + (w - qrSize) / 2;
    const qrY = y + halfH - qrSize; // top of QR at the midline
    // Push QR DOWN if there's slack between qrSize and the available
    // half-height (qrSize was capped by width). Anchor to bottomMargin.
    const qrYBottomAnchored = Math.max(y + bottomMargin, qrY);
    page.drawImage(qrImg, { x: qrX, y: qrYBottomAnchored, width: qrSize, height: qrSize });
    if (item.centerCode != null) drawCenterOverlay(page, boldFont, qrX, qrYBottomAnchored, qrSize, item.centerCode);
  } else {
    // Square / squarish: title at top, QR centred in remaining. Title
    // keeps the fixed (single-line) font size but is allowed to wrap to
    // a 2nd line — the QR is width-limited in square cells, so the
    // extra line comes out of the vertical slack above the QR rather
    // than shrinking it. `pickFontSize(..., 1)` keeps the size fixed
    // (no shrink-to-fit); `wrapToLines(..., 2)` does the wrap.
    const titleSize = pickFontSize(w, h, item.title, 1);
    const titleLines = wrapToLines(boldFont, item.title, titleSize, w - 2 * pad, 2);
    const titleTop = y + h - pad - titleSize;
    const cursorY = drawCenteredBlock(titleLines, titleTop, titleSize, boldFont, rgb(0, 0, 0));
    const qrTop = cursorY - 0.04 * PT;
    const qrBot = y + pad;
    const qrSize = Math.min(w - 2 * pad, qrTop - qrBot);
    const qrX = x + (w - qrSize) / 2;
    const qrY = qrBot + (qrTop - qrBot - qrSize) / 2;
    page.drawImage(qrImg, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    if (item.centerCode != null) drawCenterOverlay(page, boldFont, qrX, qrY, qrSize, item.centerCode);
  }
}

// White circle + black centered digit/code overlaid on the QR — same
// look as the in-app QrWithCenter SVG overlay. The circle stays at a
// fixed size (~13% of QR diameter — keeps the obscured area within
// EC=H's 30% redundancy budget) and the font auto-shrinks for longer
// strings so 1-char ("9") and 3-char ("P99") codes both fit on one
// line, properly centered (vertically: cap-height/2 above the
// baseline; horizontally: glyph midpoint at the circle's cx).
function drawCenterOverlay(page: PDFPage, font: PDFFont, qrX: number, qrY: number, qrSize: number, text: string) {
  const cx = qrX + qrSize / 2;
  const cy = qrY + qrSize / 2;
  const radius = qrSize * 0.13;
  page.drawEllipse({ x: cx, y: cy, xScale: radius, yScale: radius, color: rgb(1, 1, 1), borderWidth: 0 });

  const maxWidth = radius * 1.7;
  // Shrink from the single-char target size until width fits with a
  // small padding margin inside the circle.
  let size = radius * 1.6;
  while (font.widthOfTextAtSize(text, size) > maxWidth && size > 3) size *= 0.9;
  const tw = font.widthOfTextAtSize(text, size);
  const ch = font.heightAtSize(size, { descender: false });
  page.drawText(text, { x: cx - tw / 2, y: cy - ch / 2, size, font, color: rgb(0, 0, 0) });
}

function pickFontSize(cellW: number, cellH: number, title: string, maxLines = 2): number {
  // Width-first heuristic, in points. Roughly mirrors the rem-based
  // ladder on the web — bigger cells get bolder titles, narrow cells
  // shrink to fit. Sizes bumped ~25-30% over the original ladder
  // because the Rollo X1038's 1-bit thermal output renders small
  // text mushy — anything under ~10pt loses legibility on the print.
  const minDim = Math.min(cellW, cellH);
  let base: number;
  if (minDim >= 4 * PT) base = 30;
  else if (minDim >= 3 * PT) base = 22;
  else if (cellW >= 4 * PT) base = 18;
  else if (cellH >= 3 * PT) base = 14;
  else if (cellW >= 2.5 * PT) base = 15;
  else if (cellW >= 1.4 * PT) base = 12;
  else base = 9;
  // maxLines=1 here means "don't shrink to fit" — the square layout
  // passes 1 so titles keep a fixed size across labels (the QR below
  // is then identical too). The caller is free to wrap the result to
  // multiple lines via wrapToLines (square allows 2). Callers that
  // also want auto-shrink for narrow cells pass maxLines>1.
  if (maxLines > 1) {
    const linesNeeded = title.length / Math.max(1, cellW / (base * 0.55));
    if (linesNeeded > 2) base *= 0.85;
    if (linesNeeded > 2.6) base *= 0.85;
  }
  return base;
}

export interface RenderInput {
  /** Default size for items without their own `sizeKey`. */
  size_key: string;
  items: PrintItem[];
}

export interface RenderResult {
  pdf: Buffer;
  /** Actual sheet count after packing — caller reports this in the
   *  print-direct response so the UI can show the right number. */
  sheets: number;
}

export async function renderLabelsPdf(input: RenderInput): Promise<RenderResult> {
  const defaultSize = findSize(input.size_key);
  if (!defaultSize) throw new Error(`unknown size_key: ${input.size_key}`);

  // Resolve a per-item size_key: explicit override, else the default.
  const resolved = input.items.map((it) => {
    const key = it.sizeKey ?? input.size_key;
    const size = findSize(key);
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
    const lastRenderedRow = cells.length > 0
      ? Math.floor((cells.length - 1) / size.cols)
      : -1;
    for (let ci = 0; ci < cells.length; ci++) {
      const col = ci % size.cols;
      const row = Math.floor(ci / size.cols);
      const cellX = marginLpt + col * (cellWpt + colGapPt);
      const cellY = sheetHpt - marginTpt - (row + 1) * cellHpt - row * rowGapPt;
      // Is the grid cell immediately to the right filled?
      const rightCellFilled =
        col < size.cols - 1 &&
        ci + 1 < cells.length &&
        Math.floor((ci + 1) / size.cols) === row;
      const cellBorders: CellBorders = cellsAbut
        ? {
            top: row > 0 || size.margin_t > 0,
            left: col > 0 || size.margin_l > 0,
            right:
              (col === size.cols - 1 && size.margin_l > 0) ||
              (col < size.cols - 1 && !rightCellFilled),
            bottom: row === lastRenderedRow,
          }
        : ALL_CELL_BORDERS;
      const cellItems = cells[ci]!;
      if (subdivisions === 1) {
        if (cellItems[0]) await placeLabel(page, doc, font, boldFont, cellItems[0], cellX, cellY, cellWpt, cellHpt, cellBorders);
      } else {
        for (let si = 0; si < subdivisions; si++) {
          const it = cellItems[si];
          if (!it) continue;
          const subX = cellX + si * subWpt;
          await placeLabel(page, doc, font, boldFont, it, subX, cellY, subWpt, cellHpt, cellBorders);
        }
      }
    }
  }

  return { pdf: Buffer.from(await doc.save()), sheets: pages.length };
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
      await placeLabel(page, doc, font, boldFont, placement.item.item, cellX, cellY, cellWpt, cellHpt);
    }
  }

  return { pdf: Buffer.from(await doc.save()), sheets: sheets.length };
}
