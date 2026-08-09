// ONE label geometry, shared by every renderer.
//
// A label gets drawn by three different code paths — the ⌘P/preview HTML, the
// Bluetooth canvas raster, and the server-side PDF (pdf-lib, what network
// printers and auto-print actually receive). Each used to compute the caption box
// itself, and they drifted: the HTML and Bluetooth paths disagreed by up to 14%,
// and the PDF (a hardcoded font ladder) was anywhere from 0.37x to 2.28x the
// others for the same label. Same label, three sizes.
//
// This lives in platform-contract because it must be reachable from BOTH the
// browser and the API: the PDF renderer runs server-side and cannot import
// platform-web (browser deps), so a shared geometry had nowhere else to live.
// Pure arithmetic, no dependencies.
//
// Everything is a FRACTION of the face, so the caller's unit is the answer's unit
// — inches for the HTML sheet, dots for the thermal raster, points for the PDF.

/** The inner arrangement of one label cell, chosen by aspect. */
export type LabelLayout = "row" | "portrait" | "square";

/** Aspect thresholds. Unit-independent, so dots and inches agree. */
export function labelLayoutFor(width: number, height: number): LabelLayout {
  const aspect = height > 0 ? width / height : 999;
  if (aspect <= 0.85) return "portrait";
  if (aspect < 1.2) return "square";
  return "row";
}

export interface CaptionBox {
  /** Usable content box, after the whitespace margin. */
  contentW: number;
  contentH: number;
  /** The QR square's side — fixed by the FACE, never by the caption, so every
   *  label's QR matches and is as large as it can be. */
  qrSize: number;
  /** Margin below the QR. The QR anchors to this floor so QR bottoms line up
   *  across a tiled row. */
  floor: number;
  /** The caption strip, and the (safety-biased) box to fit text into. fitH is
   *  smaller than strip because a rendered line box slightly exceeds the fitter's
   *  estimate; without the bias the caption gets clipped. */
  strip: number;
  fitW: number;
  fitH: number;
  /** The margins actually applied, so a renderer positions content at the same
   *  inset this box was computed from instead of recomputing it. */
  marginX: number;
  marginY: number;
  /** Readability floor, capped so it can never exceed what the strip holds. */
  minFont: number;
  maxLines: number;
}

/** Margin as a fraction of the shorter side, DOWN THE FEED (top and bottom).
 *  Whitespace so a 50 mm label prints ~46 mm centred rather than filling the head
 *  to a clipped edge. */
export const MARGIN_FRAC = 0.06;
/** Margin at the SIDES, which needs to be bigger than the feed-direction one.
 *  A roll is held straight down the feed by the gap sensor, but it wanders
 *  LATERALLY in the feed path — and the printable width can be narrower than the
 *  media besides. A symmetric margin therefore clips the right edge first, which
 *  is exactly what showed up on a 2-up print (reported 2026-07). Wider sides cost a
 *  little QR size and buy tolerance against a physical error we cannot control. */
export const SIDE_MARGIN_FRAC = 0.11;
/** Floor under the QR, as a fraction of the margin. */
export const FLOOR_FRAC = 0.5;
/** Rendered line height (the HTML `.desc` line-height; canvas + PDF match it). */
export const RENDER_LINE = 1.15;

export function captionBox(w: number, h: number, layout: LabelLayout): CaptionBox {
  const short = Math.min(w, h);
  const mX = short * SIDE_MARGIN_FRAC; // sides: absorbs lateral paper wander
  const mY = short * MARGIN_FRAC;      // feed direction: the gap sensor holds this
  const m = mY;
  const contentW = Math.max(w * 0.05, w - 2 * mX);
  const contentH = Math.max(h * 0.05, h - 2 * mY);
  if (layout === "row") {
    // QR is a square on the left at full content height; the caption is the
    // column to its right, less a gutter.
    const qrSize = contentH;
    const fitW = Math.max(w * 0.05, contentW - qrSize - m * 0.8);
    const fitH = contentH * 0.9;
    const maxLines = 3;
    return {
      contentW, contentH, qrSize, floor: 0, strip: contentH, fitW, fitH, marginX: mX, marginY: mY,
      minFont: Math.min(h * 0.1, (fitH * 0.85) / (maxLines * RENDER_LINE)),
      maxLines,
    };
  }
  // portrait / square: a fixed max QR anchored to the floor, caption above it.
  const qrSize = layout === "square" ? contentW * 0.82 : Math.min(contentW, contentH);
  const floor = m * FLOOR_FRAC;
  const strip = Math.max(h * 0.02, contentH - qrSize - floor);
  // The caption's HEIGHT BUDGET is computed against the QR the face would carry
  // with feed margins on all sides — NOT against the narrower drawn QR. Widening
  // the side margins shrinks the QR, which GROWS the leftover strip; letting the
  // fitter fill that grown strip inflated fonts ~50% and a wide name clipped
  // ("Thumper" -> "Thumpe", reported 2026-07). Side margins exist to buy edge
  // CLEARANCE against paper wander; they must never change the typography that
  // was approved under the symmetric geometry.
  const qrFeed = layout === "square" ? (w - 2 * mY) * 0.82 : Math.min(w - 2 * mY, contentH);
  const stripText = Math.max(h * 0.02, contentH - qrFeed - floor);
  const fitH = Math.min(strip, stripText) * 0.85;
  const maxLines = 2;
  return {
    contentW, contentH, qrSize, floor, strip, fitW: contentW, fitH, marginX: mX, marginY: mY,
    minFont: Math.min(h * 0.1, (fitH * 0.85) / (maxLines * RENDER_LINE)),
    maxLines,
  };
}
