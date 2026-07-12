// Build a self-contained, print-ready HTML doc for ⌘P. Lays labels
// onto the chosen paper at real inch dimensions, tiled by the
// LabelSize's col×row grid. Each cell picks
// one of three inner layouts (row / portrait / square) from its
// aspect ratio. `@page size` is set to the paper so the browser
// prints 1:1 with no scaling.

import type { Printable } from "./api";
import {
  cellLayout,
  findLabelSize,
  findPaper,
  perSheet,
  type LabelSize,
} from "./sizes";

interface RenderOpts {
  /** Render only the first sheet (used for the on-screen preview). */
  previewOnly?: boolean;
}

/** Center-code badge shape, by code length. A 1-2 char code (`c1`) reads as a
 *  solid circle; 3+ chars (`mn12`) as a stadium pill. Kept as a pure exported
 *  helper so the shape rule is unit-testable and matches the PDF path's
 *  circle-for-short / capsule-for-long capsule geometry (print/qr-overlay.ts). */
export function codeBadgeClass(code: string): "code-circle" | "code-pill" {
  return code.length <= 2 ? "code-circle" : "code-pill";
}

export function renderPrintSheetHtml(
  items: Printable[],
  sizeKey: string,
  opts: RenderOpts = {},
): string {
  const size = findLabelSize(sizeKey);
  const paper = size ? findPaper(size.paper) : undefined;
  if (!size || !paper) {
    return `<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;padding:2rem">
      Unknown label size "<b>${escapeHtml(sizeKey)}</b>".</body>`;
  }

  const cap = perSheet(size);
  const pageItems = opts.previewOnly ? items.slice(0, cap) : items;
  const pages: Printable[][] = [];
  for (let i = 0; i < pageItems.length; i += cap) {
    pages.push(pageItems.slice(i, i + cap));
  }
  if (pages.length === 0) pages.push([]);

  const sheets = pages.map((page) => renderSheet(page, size)).join("\n");
  const fontPt = Math.max(8, Math.min(15, Math.round(size.label_h * 6)));

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
    border: 1px dashed #c8ccd2;
    padding: 0.07in;
    overflow: hidden;
  }
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
  .label .desc {
    font-size: ${fontPt}pt;
    font-weight: 600;
    line-height: 1.15;
    word-break: break-word;
    overflow: hidden;
  }
  /* row — QR left, text right */
  .label.row { display: flex; align-items: center; gap: 0.08in; }
  .label.row .qr { height: 100%; aspect-ratio: 1; order: -1; }
  .label.row .desc { flex: 1; }
  /* portrait — text on top, QR pinned below, centered */
  .label.portrait { display: flex; flex-direction: column; gap: 0.05in; }
  .label.portrait .desc { text-align: center; }
  .label.portrait .qr { margin: auto auto 0; width: 86%; aspect-ratio: 1; }
  /* square — short title on top, QR fills the rest */
  .label.square { display: flex; flex-direction: column; gap: 0.04in; }
  .label.square .desc { text-align: center; flex-shrink: 0; }
  .label.square .qr { flex: 1; min-height: 0; aspect-ratio: 1; margin: 0 auto; }
  @media print {
    .label { border: 1px solid #d4d8de; }
  }
</style>
</head>
<body>
${sheets}
</body>
</html>`;
}

function renderSheet(items: Printable[], size: LabelSize): string {
  const layout = cellLayout(size);
  // Center-code font, sized to the QR's on-paper side (~15% of it), so the pill
  // reads from a distance but stays inside the QR for short codes.
  const qrSideIn =
    layout === "row"
      ? Math.max(0.1, size.label_h - 0.14)
      : layout === "portrait"
        ? 0.86 * size.label_w
        : Math.min(size.label_w, size.label_h) * 0.7;
  const codePt = Math.max(6, Math.min(30, qrSideIn * 72 * 0.15));
  const cells = items
    .map((it, k) => {
      const col = k % size.cols;
      const row = Math.floor(k / size.cols);
      const left = size.margin_l + col * (size.label_w + size.col_gap);
      const top = size.margin_t + row * (size.label_h + size.row_gap);
      const badge = it.center_code
        ? `<span class="code ${codeBadgeClass(it.center_code)}" style="font-size:${codePt.toFixed(1)}pt">${escapeHtml(it.center_code)}</span>`
        : "";
      return `    <div class="label ${layout}" style="left:${left}in;top:${top}in;width:${size.label_w}in;height:${size.label_h}in">
      <div class="desc">${escapeHtml(it.description)}</div>
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
