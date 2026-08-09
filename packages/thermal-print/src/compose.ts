// Thermal n-up composition (D8): place N label bitmaps onto ONE media bitmap so a
// Bluetooth printer feeds a whole tiled sheet in a single pass, instead of one
// label per feed. renderLabelBitmap makes one label; this blits several onto the
// loaded media at the grid offsets deriveGrid/mediaTiles computes. Pure 1-bpp bit
// manipulation (same MSB-first layout as packMonoBitmap), so it is unit-testable
// with no canvas. See docs/design-decisions/label-media-and-accumulation.md D8.

import { mmToDots, PHOMEMO_DPI, type MonoBitmap } from "./protocol.js";
import { mediaTiles, type LabelFace, type LabelMedia } from "./media.js";

/** An all-white bitmap of the given dot dimensions (every bit 0). */
export function blankBitmap(width: number, height: number): MonoBitmap {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const bytesPerLine = Math.ceil(w / 8);
  return { width: w, height: h, bytesPerLine, rows: new Uint8Array(bytesPerLine * h) };
}

/** Copy every set (black) bit of `src` into `dest` at dot offset (dx, dy). Bits
 *  that fall outside `dest` are clipped. MSB-first, matching packMonoBitmap. */
export function blit(dest: MonoBitmap, src: MonoBitmap, dx: number, dy: number): void {
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  for (let sy = 0; sy < src.height; sy++) {
    const ty = oy + sy;
    if (ty < 0 || ty >= dest.height) continue;
    const srcBase = sy * src.bytesPerLine;
    const destBase = ty * dest.bytesPerLine;
    for (let sx = 0; sx < src.width; sx++) {
      if ((src.rows[srcBase + (sx >> 3)]! & (0x80 >> (sx & 7))) === 0) continue; // white
      const tx = ox + sx;
      if (tx < 0 || tx >= dest.width) continue;
      const bi = destBase + (tx >> 3);
      dest.rows[bi] = dest.rows[bi]! | (0x80 >> (tx & 7));
    }
  }
}

export interface NUpGrid {
  cols: number;
  rows: number;
  labelWDots: number;
  labelHDots: number;
  colGapDots: number;
  rowGapDots: number;
  marginLDots?: number;
  marginTDots?: number;
  /** Draw a solid CUT GUIDE at each internal column/row seam — for continuous media
   *  tiled n-up, which the user cuts apart. It lands in the labels' whitespace
   *  margin, so it marks the cut without touching content. Off for die-cut stock
   *  (already separated). */
  divider?: boolean;
}

/** Paint a solid black vertical line (2 dots wide for visibility) down `bmp`. */
function fillVLine(bmp: MonoBitmap, x: number, y0: number, y1: number): void {
  for (let dx = 0; dx < 2; dx++) {
    const tx = Math.round(x) + dx;
    if (tx < 0 || tx >= bmp.width) continue;
    for (let y = Math.max(0, y0); y < Math.min(bmp.height, y1); y++) {
      bmp.rows[y * bmp.bytesPerLine + (tx >> 3)]! |= 0x80 >> (tx & 7);
    }
  }
}

/** Top-left dot position of each of the first `count` labels, laid FIFO onto the
 *  grid: label i at col = i % cols, row = floor(i / cols). Capped at cols×rows. */
export function nUpOffsets(count: number, g: NUpGrid): Array<{ x: number; y: number }> {
  const cols = Math.max(1, g.cols);
  const cap = cols * Math.max(1, g.rows);
  const mL = g.marginLDots ?? 0;
  const mT = g.marginTDots ?? 0;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < Math.min(count, cap); i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: mL + col * (g.labelWDots + g.colGapDots),
      y: mT + row * (g.labelHDots + g.rowGapDots),
    });
  }
  return out;
}

/** Compose up to cols×rows label bitmaps onto a fresh media bitmap. `mediaWDots`
 *  is the loaded media width; the media height covers only the rows actually used
 *  (a continuous roll feeds only what's printed; a partial last row leaves its
 *  remaining tiles blank). Labels past capacity are ignored (the caller paginates). */
export function composeNUp(labels: MonoBitmap[], mediaWDots: number, g: NUpGrid): MonoBitmap {
  const cols = Math.max(1, g.cols);
  const cap = cols * Math.max(1, g.rows);
  const n = Math.min(labels.length, cap);
  const usedRows = n === 0 ? 0 : Math.ceil(n / cols);
  const mT = g.marginTDots ?? 0;
  const heightDots = mT + usedRows * g.labelHDots + Math.max(0, usedRows - 1) * g.rowGapDots;
  const media = blankBitmap(mediaWDots, heightDots);
  const offsets = nUpOffsets(n, g);
  offsets.forEach((off, i) => blit(media, labels[i]!, off.x, off.y));
  // Cut guide between tiled faces (continuous media): a solid seam in the gutter.
  if (g.divider && cols > 1) {
    const mL = g.marginLDots ?? 0;
    for (let c = 1; c < cols; c++) {
      const seamX = mL + c * (g.labelWDots + g.colGapDots) - Math.ceil(g.colGapDots / 2) - 1;
      fillVLine(media, seamX, 0, heightDots);
    }
  }
  return media;
}

/** Ergonomic entry for the print path: compose label bitmaps onto the loaded media
 *  using the media+label model. Derives the grid (mediaTiles) and all dot
 *  dimensions from mm at the printer's dpi. */
export function composeMediaNUp(
  labels: MonoBitmap[],
  media: LabelMedia,
  label: LabelFace,
  dpi: number = PHOMEMO_DPI,
): MonoBitmap {
  const { cols, rows } = mediaTiles(media, label);
  const gapDots = media.feed === "die-cut" ? mmToDots(media.gapMm, dpi) : 0;
  return composeNUp(labels, mmToDots(media.widthMm, dpi), {
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
    labelWDots: mmToDots(label.widthMm, dpi),
    labelHDots: mmToDots(label.heightMm, dpi),
    // Faces pack across the width (their margins are inside each face); only the
    // feed direction carries the die-cut gap, between stacked physical labels.
    colGapDots: 0,
    rowGapDots: gapDots,
    // Any 2-up tiling gets a printed cut guide between the columns — you always cut
    // side-by-side faces apart. (It was gated on feed !== "die-cut", but the feed
    // defaults to die-cut when a printer hasn't stored one, so a plain 50×30 roll
    // printed 2-up got no line at all — reported 2026-07.) It lands in the labels'
    // whitespace gutter, so a rare pre-die-cut 2-up is unharmed.
    divider: Math.max(1, cols) > 1,
  });
}

/** Chunk a run of label bitmaps into MEDIA sheets — cols×rows labels each, composed
 *  by composeMediaNUp — so the print path feeds one sheet per pass. One-up media
 *  (tiles=1) yields one sheet per label (the historical one-per-feed behaviour); a
 *  final partial chunk leaves its remaining tiles blank (D6). */
export function tileBatch(
  labels: MonoBitmap[],
  media: LabelMedia,
  label: LabelFace,
  dpi: number = PHOMEMO_DPI,
): MonoBitmap[] {
  const { cols, rows } = mediaTiles(media, label);
  const perSheet = Math.max(1, Math.max(1, cols) * Math.max(1, rows));
  const sheets: MonoBitmap[] = [];
  for (let i = 0; i < labels.length; i += perSheet) {
    sheets.push(composeMediaNUp(labels.slice(i, i + perSheet), media, label, dpi));
  }
  return sheets;
}
