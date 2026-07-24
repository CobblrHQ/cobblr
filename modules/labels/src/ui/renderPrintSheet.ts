// Build a self-contained, print-ready HTML doc for ⌘P. Lays labels
// onto the chosen paper at real inch dimensions, tiled by the
// LabelSize's col×row grid. Each cell picks
// one of three inner layouts (row / portrait / square) from its
// aspect ratio. `@page size` is set to the paper so the browser
// prints 1:1 with no scaling.

import { fitCaptionPx } from "@cobblr/platform-web";
import type { CustomLabelSize, Printable } from "./api";
import {
  cellLayout,
  customSizeToLayout,
  findLabelSize,
  findPaper,
  perSheet,
  qrSideForLabel,
  type CellLayout,
  type LabelSize,
  type PaperSize,
} from "../label-sizes";

/** The caption font (pt) for ONE label — auto-fit so a short name prints large and
 *  a long one shrinks/wraps. Uses the SAME shared fitCaptionPx as the Bluetooth
 *  renderer, over the caption's box in this layout, so preview and print size text
 *  the same. Dimensions are inches; fitCaptionPx returns inches, ×72 → points. */
export function captionFontPt(caption: string, size: LabelSize, layout: CellLayout): number {
  const w = size.label_w, h = size.label_h;
  const PAD = 0.16; // width bias so the HTML doesn't re-wrap to an extra line
  if (layout === "row") {
    // QR is an h×h square on the left; the caption is the column to its right at full
    // content height. Same accurate-box + dynamic-floor treatment as the others so a
    // long name shrinks to fit rather than ellipsising.
    const contentW = Math.max(0.1, w - 0.14), contentH = Math.max(0.1, h - 0.14);
    const boxW = Math.max(0.1, contentW - contentH - 0.08); // minus the QR square + flex gap
    const boxH = contentH * 0.9;
    const min = Math.min(10 / 72, (boxH * 0.85) / (3 * 1.15));
    return fitCaptionPx(caption, boxW, boxH, { maxLines: 3, min, max: boxH }) * 72;
  }
  // portrait / square: the QR is a FIXED square below the caption; the caption gets
  // the strip left ABOVE it. Size the font to the ACTUAL strip height — content height
  // MINUS the QR square MINUS the flex gap — and bias it small: the CSS line-height
  // (1.15) is taller than the 1.12 the fitter assumes and browser glyph metrics vary,
  // so a font sized to the raw strip overruns it and overflow:hidden cuts the caption.
  // (the author 2026-07: the fixed-QR change sized to h−w, ignoring the gap + padding, so
  // BOTH a 1-line and a 2-line name got clipped.)
  const contentW = Math.max(0.1, w - 0.14), contentH = Math.max(0.1, h - 0.14);
  const qrH = (layout === "square" ? 0.82 : 1) * contentW; // matches the .qr width in CSS
  // The caption fills the space ABOVE the QR. The QR is bottom-anchored to a floor
  // 0.04in above the edge (so its bottom lines up across a row — the author, 2026-07);
  // subtract that floor margin so the caption box matches the real desc height.
  const strip = Math.max(0.06, contentH - qrH - 0.04);
  const boxH = strip * 0.9; // safety margin so the rendered line-box fits the box
  const maxLines = 2;
  // Floor the font for readability (raised per the author so a long name is not tiny), but
  // NEVER above what the strip can actually hold (else the floor itself clips a
  // near-square face where the strip is tiny).
  const min = Math.min(10 / 72, (strip * 0.85) / (maxLines * 1.15));
  return fitCaptionPx(caption, Math.max(0.1, w - PAD), boxH, { maxLines, min, max: boxH }) * 72;
}

interface RenderOpts {
  /** Render only the first sheet (used for the on-screen preview). */
  previewOnly?: boolean;
  /** Workspace-defined sizes, so a `custom:<id>` key resolves to its dimensions.
   *  Omitted for the built-in presets (and for the milestone golden). */
  customSizes?: CustomLabelSize[];
  /** Turn each label's CONTENT 90° while the label box keeps its on-paper w×h
   *  (grid, tiling and cut-guides unchanged). A landscape face (50×30) then reads
   *  portrait when the label is stood on end. Opt-in: off ⇒ byte-identical to the
   *  un-rotated sheet (the milestone golden), so the toggle can't regress it. */
  rotate?: boolean;
}

/** A size key to its (LabelSize, PaperSize), built-in or `custom:<id>`. */
function resolveSize(
  sizeKey: string,
  customSizes: CustomLabelSize[] | undefined,
): { size: LabelSize; paper: PaperSize } | undefined {
  if (sizeKey.startsWith("custom:")) {
    const id = sizeKey.slice("custom:".length);
    const row = customSizes?.find((c) => c.id === id);
    return row ? customSizeToLayout(row) : undefined;
  }
  const size = findLabelSize(sizeKey);
  const paper = size ? findPaper(size.paper) : undefined;
  return size && paper ? { size, paper } : undefined;
}

/** Center-code badge shape, by code length. A 1-2 char code (`c1`) reads as a
 *  solid circle; 3+ chars (`mn12`) as a stadium pill. Kept as a pure exported
 *  helper so the shape rule is unit-testable and matches the PDF path's
 *  circle-for-short / capsule-for-long capsule geometry (print/qr-overlay.ts). */
export function codeBadgeClass(code: string): "code-circle" | "code-pill" {
  return code.length <= 2 ? "code-circle" : "code-pill";
}

// CSS emitted ONLY when opts.rotate is on (so the un-rotated sheet stays byte-
// identical to the golden). The label box keeps its on-paper w×h; a swapped-
// dimension inner box is centered and turned 90°. The inner reuses the same
// three cell layouts as an upright label — but on `.rot-inner`, since `.label`
// no longer carries the layout class. The base `.label .qr` / `.desc` / `.code`
// rules still apply by descendant match, so QR sizing + badges are unchanged.
const ROTATE_CSS = `  .label.rot { padding: 0; }
  .label.rot .rot-inner {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(90deg);
    padding: 0.07in; overflow: hidden;
  }
  .rot-inner.row { display: flex; align-items: center; gap: 0.08in; }
  .rot-inner.row .qr { height: 100%; aspect-ratio: 1; order: -1; }
  .rot-inner.row .desc { flex: 1; }
  .rot-inner.portrait { display: flex; flex-direction: column; gap: 0; }
  .rot-inner.portrait .desc { text-align: center; flex: 1; min-height: 0; align-items: flex-start; }
  .rot-inner.portrait .qr { width: 100%; aspect-ratio: 1; flex-shrink: 0; margin: 0 auto 0.04in; }
  .rot-inner.square { display: flex; flex-direction: column; gap: 0; }
  .rot-inner.square .desc { text-align: center; flex: 1; min-height: 0; align-items: flex-start; }
  .rot-inner.square .qr { width: 82%; aspect-ratio: 1; flex-shrink: 0; margin: 0 auto 0.04in; }
  .rot-inner.portrait .desc > span, .rot-inner.square .desc > span { -webkit-line-clamp: 2; }
  .rot-inner.row .desc > span { -webkit-line-clamp: 3; }
`;

export function renderPrintSheetHtml(
  items: Printable[],
  sizeKey: string,
  opts: RenderOpts = {},
): string {
  const resolved = resolveSize(sizeKey, opts.customSizes);
  if (!resolved) {
    return `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;padding:2rem">
      Unknown label size "<b>${escapeHtml(sizeKey)}</b>".</body>`;
  }
  const { size, paper } = resolved;

  const cap = perSheet(size);
  const pageItems = opts.previewOnly ? items.slice(0, cap) : items;
  const pages: Printable[][] = [];
  for (let i = 0; i < pageItems.length; i += cap) {
    pages.push(pageItems.slice(i, i + cap));
  }
  if (pages.length === 0) pages.push([]);

  const rotate = opts.rotate ?? false;
  const sheets = pages.map((page) => renderSheet(page, size, rotate)).join("\n");
  // Caption font is per-label now (captionFontPt), set inline on each .desc, so a
  // short name fills its box while a long one shrinks — the sheet no longer carries
  // one fixed size.

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Cobblr labels — ${escapeHtml(size.label)}</title>
<style>
  @page { size: ${paper.width_in}in ${paper.height_in}in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Inter, system-ui, -apple-system, sans-serif;
    color: #1f2530;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet {
    position: relative;
    width: ${paper.width_in}in;
    height: ${paper.height_in}in;
    page-break-after: always;
    overflow: hidden;
  }
  .sheet:last-child { page-break-after: auto; }
  .label {
    position: absolute;
    padding: 0.07in;
    overflow: hidden;
  }
  /* Cut guide: a dark line ONLY on a seam BETWEEN two filled cells (drawn once, by
     the upper/left cell), so you cut on it. No full per-cell border — a blanket
     border doubled at every abutment and framed a partial sheet's empty half with a
     stark box (the author, 2026-07). The seam prints black. */
  .label.seam-r { border-right: 1px solid #1a1a1a; }
  .label.seam-b { border-bottom: 1px solid #1a1a1a; }
  .label .qr { flex-shrink: 0; position: relative; }
  .label .qr svg { display: block; width: 100%; height: 100%; }
  /* Human-readable code overlaid in the QR center; the QR is EC=H so the
     covered center still decodes. Short codes (1-2 chars) get a solid circle,
     longer ones a stadium pill — matching the PDF path (print/qr-overlay.ts).
     A single squished oval for a 2-char code was the bug this replaces. */
  .label .code {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: #fff; color: #111; font-weight: 800; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    font-family: Inter, system-ui, -apple-system, sans-serif;
  }
  /* Circle for 1-2 chars: an equal-sided box, sized in em so it tracks codePt. */
  .label .code.code-circle {
    width: 1.7em; height: 1.7em; border-radius: 50%;
  }
  /* Pill for 3+ chars: fixed height, min-width so 3 chars already read as a
     stadium, horizontal padding, fully-rounded ends. */
  .label .code.code-pill {
    height: 1.5em; min-width: 2.6em; padding: 0 0.35em;
    border-radius: 999px; white-space: nowrap;
  }
  /* .desc is a flex box that CENTRES the caption span vertically + horizontally in
     its strip (so the name sits in the middle of the whitespace above the QR — the author,
     2026-07); the inner span carries the -webkit-box line-clamp. */
  .label .desc {
    font-weight: 600;
    line-height: 1.15;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .label .desc > span {
    display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
    word-break: break-word; max-width: 100%;
  }
  /* row — QR left, text right */
  .label.row { display: flex; align-items: center; gap: 0.08in; }
  .label.row .qr { height: 100%; aspect-ratio: 1; order: -1; }
  .label.row .desc { flex: 1; }
  /* portrait — QR FIRST: a full-width square (the biggest it fits), the name fills
     the strip left on top. QR size is set by the face, never by the caption. */
  .label.portrait { display: flex; flex-direction: column; gap: 0; }
  .label.portrait .desc { text-align: center; flex: 1; min-height: 0; align-items: flex-start; }
  .label.portrait .qr { width: 100%; aspect-ratio: 1; flex-shrink: 0; margin: 0 auto 0.04in; }
  /* square — QR is 82% width (leaves a caption strip); the name fills the strip. */
  .label.square { display: flex; flex-direction: column; gap: 0; }
  .label.square .desc { text-align: center; flex: 1; min-height: 0; align-items: flex-start; }
  .label.square .qr { width: 82%; aspect-ratio: 1; flex-shrink: 0; margin: 0 auto 0.04in; }
  /* Cap caption lines so the preview + the thermal print (which hard-wraps to the
     same counts) agree — the fit sizes the font for these. Ellipsise rather than
     push the QR down. (The rotated-cell variants live in ROTATE_CSS so the
     un-rotated sheet stays byte-identical.) */
  .label.portrait .desc > span, .label.square .desc > span { -webkit-line-clamp: 2; }
  .label.row .desc > span { -webkit-line-clamp: 3; }
${rotate ? ROTATE_CSS : ""}  @media print {
    .label.seam-r { border-right-color: #000; }
    .label.seam-b { border-bottom-color: #000; }
  }
</style>
</head>
<body>
${sheets}
</body>
</html>`;
}

function renderSheet(items: Printable[], size: LabelSize, rotate: boolean): string {
  // Rotating turns the CONTENT 90°, so lay it out for the swapped cell: a
  // landscape face's aspect inverts to portrait and the QR/text arrange for that.
  // Off ⇒ layoutSize === size, so everything below is byte-identical to before.
  const layoutSize = rotate ? { ...size, label_w: size.label_h, label_h: size.label_w } : size;
  const layout = cellLayout(layoutSize);
  // Center-code font, sized to the QR's on-paper side (~15% of it), so the pill
  // reads from a distance but stays inside the QR for short codes.
  const qrSideIn = qrSideForLabel(layoutSize);
  const codePt = Math.max(6, Math.min(30, qrSideIn * 72 * 0.15));
  const cells = items
    .map((it, k) => {
      const col = k % size.cols;
      const row = Math.floor(k / size.cols);
      const left = size.margin_l + col * (size.label_w + size.col_gap);
      const top = size.margin_t + row * (size.label_h + size.row_gap);
      // A cut seam is drawn ONCE, by the upper/left cell, and only where the
      // neighbour it abuts is actually filled — so an abutment isn't doubled and a
      // partial last sheet has no stark line beside its empty half.
      const rightSeam = col < size.cols - 1 && k + 1 < items.length;
      const bottomSeam = row < size.rows - 1 && k + size.cols < items.length;
      const seams = `${rightSeam ? " seam-r" : ""}${bottomSeam ? " seam-b" : ""}`;
      const badge = it.center_code
        ? `<span class="code ${codeBadgeClass(it.center_code)}" style="font-size:${codePt.toFixed(1)}pt">${escapeHtml(it.center_code)}</span>`
        : "";
      // Per-label caption font: a short name fills its box, a long one shrinks.
      const descPt = captionFontPt(it.description, layoutSize, layout).toFixed(1);
      if (rotate) {
        // Label box stays at on-paper w×h (grid/cut-guides unchanged); the inner
        // box is the SWAPPED size, turned 90° by ROTATE_CSS to fill the cell.
        return `    <div class="label rot${seams}" style="left:${left}in;top:${top}in;width:${size.label_w}in;height:${size.label_h}in">
      <div class="rot-inner ${layout}" style="width:${size.label_h}in;height:${size.label_w}in">
        <div class="desc" style="font-size:${descPt}pt"><span>${escapeHtml(it.description)}</span></div>
        <div class="qr">${it.qr_svg}${badge}</div>
      </div>
    </div>`;
      }
      return `    <div class="label ${layout}${seams}" style="left:${left}in;top:${top}in;width:${size.label_w}in;height:${size.label_h}in">
      <div class="desc" style="font-size:${descPt}pt"><span>${escapeHtml(it.description)}</span></div>
      <div class="qr">${it.qr_svg}${badge}</div>
    </div>`;
    })
    .join("\n");
  return `  <div class="sheet">\n${cells}\n  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
