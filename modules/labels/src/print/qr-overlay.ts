// Center-code overlay geometry + scannability validation for QR labels.
//
// A short human-readable code (m1, p42, b7) is drawn in the middle of the QR
// so a person can read it off a shelf without scanning. The legacy overlay was
// a fixed white circle, which shrinks the glyphs in both dimensions at once and
// tops out at ~2-3 legible chars. This replaces it with a horizontal capsule
// (a stadium): fixed vertical half-height, width that grows with the code, so
// the glyph height stays constant and 5-ish chars stay legible. A 1-char code
// yields a zero-length middle => the capsule IS a circle, so short codes look
// exactly like before.
//
// Anything drawn over a QR spends its error-correction budget. At EC level H a
// QR recovers ~30% of its modules; cover more (or clip a finder pattern) and it
// stops scanning. So every overlay is validated against the real module matrix
// and unsafe labels are flagged rather than silently printed. Pure functions,
// no pdf-lib dependency (the caller injects text measurement) so this is
// straightforwardly unit-testable.
//
// See docs/design-decisions/label-codes.md.

import QRCode from "qrcode";

/** EC level H recovers roughly this fraction of a QR's modules. */
export const EC_H_BUDGET = 0.3;
/** Unsafe above this. Held a margin under EC_H_BUDGET so a label still scans
 *  after real-world thermal-print smudging / off-angle phone scans. */
export const OVERLAY_SAFE_THRESHOLD = 0.28;

// Quiet-zone margin (in modules) baked into the rendered QR image. Must match
// the `margin` passed to qrcode in pdf.ts (qrPng uses margin:1), because the
// overlay is positioned over the whole image, quiet zone included.
const QUIET_MODULES = 1;

// Vertical half-height of the capsule as a fraction of the QR square. Matches
// the legacy circle radius (qrSize * 0.13): short codes look identical, and it
// keeps the capsule's band clear of the corner finder patterns.
const CAPSULE_HALF_HEIGHT = 0.13;
// The capsule's outer half-width may not exceed this fraction of the QR, so it
// can never stretch into a corner finder pattern. Font shrinks to respect it.
const MAX_HALF_WIDTH = 0.44;

export interface Capsule {
  /** Center of the capsule, as a fraction of the QR square (0..1). */
  cx: number;
  cy: number;
  /** Vertical half-height, fraction of the QR square. */
  hh: number;
  /** Half-length of the straight (rectangular) middle, fraction of the QR
   *  square. The rounded caps (radius `hh`) extend `hh` beyond each end, so a
   *  1-char code with hwInner ~ 0 renders as a plain circle. */
  hwInner: number;
  /** Font size, in points, for the code text. */
  fontSize: number;
}

/** Measure the drawn width of `text` at `sizePt` points. In the renderer this
 *  is pdf-lib's `PDFFont.widthOfTextAtSize`; injected so this module stays a
 *  pure function with no pdf-lib dependency. */
export type MeasureText = (text: string, sizePt: number) => number;

/**
 * Size a horizontal capsule for `text` inside a `qrSize`-pt square QR.
 *
 * The glyph height is held fixed (that is the win over the circle, which shrank
 * the font to fit width); only the straight middle grows with the measured text
 * width. If the capsule would reach past MAX_HALF_WIDTH toward the finder
 * patterns, the font shrinks until it fits.
 */
export function computeCapsule(qrSize: number, text: string, measure: MeasureText): Capsule {
  const hhPt = qrSize * CAPSULE_HALF_HEIGHT;
  // Target cap height ~ the capsule's inner height; stays fixed with char count.
  let fontSize = hhPt * 1.5;
  const maxOuterPt = qrSize * MAX_HALF_WIDTH;

  // The straight middle holds the text; the rounded caps (radius hhPt) are pure
  // padding. Shrink the font only if the whole capsule would exceed the cap.
  let halfTextPt = measure(text, fontSize) / 2;
  while (halfTextPt + hhPt > maxOuterPt && fontSize > 3) {
    fontSize *= 0.9;
    halfTextPt = measure(text, fontSize) / 2;
  }

  return {
    cx: 0.5,
    cy: 0.5,
    hh: CAPSULE_HALF_HEIGHT,
    hwInner: halfTextPt / qrSize,
    fontSize,
  };
}

export interface OverlayValidation {
  /** QR symbol version (1-40); more data => higher version => more modules. */
  version: number;
  /** Data modules per side (n); the symbol is n x n excluding the quiet zone. */
  moduleCount: number;
  /** n * n. */
  totalModules: number;
  coveredModules: number;
  coveredFraction: number;
  /** EC_H_BUDGET, for context in the flag message. */
  budget: number;
  /** OVERLAY_SAFE_THRESHOLD. */
  safeThreshold: number;
  /** True if the capsule intersects any of the three finder patterns. */
  finderCollision: boolean;
  /** The label will scan: coverage within budget AND no finder collision. */
  safe: boolean;
  /** Human-readable reason when `safe` is false. */
  reason?: string;
}

/**
 * Count how many of the QR's modules the capsule obscures and decide whether
 * the label will still scan. Unsafe when coverage exceeds OVERLAY_SAFE_THRESHOLD
 * or the capsule clips a finder pattern.
 *
 * Payload-aware by construction: a longer URL raises the module count, which
 * shrinks the covered fraction for the same physical capsule — so this is a
 * real budget check, not a fixed character cap.
 */
export function validateOverlay(payload: string, capsule: Capsule): OverlayValidation {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const n = qr.modules.size;
  const total = n * n;
  const grid = n + 2 * QUIET_MODULES; // the rendered image spans this many modules
  const { cx, cy, hh, hwInner } = capsule;

  // Finder pattern = 7 modules + a 1-module separator = an 8x8 block in each of
  // three corners (top-left, top-right, bottom-left).
  const f = 8;
  const inFinder = (c: number, r: number) =>
    (c < f && r < f) || (c >= n - f && r < f) || (c < f && r >= n - f);

  let covered = 0;
  let finderCollision = false;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // Module center as a fraction of the full image (which maps to the QR square).
      const fx = (QUIET_MODULES + c + 0.5) / grid;
      const fy = (QUIET_MODULES + r + 0.5) / grid;
      const dy = Math.abs(fy - cy);
      if (dy > hh) continue;
      const overhang = Math.max(0, Math.abs(fx - cx) - hwInner);
      if (overhang * overhang + dy * dy > hh * hh) continue; // stadium point test
      covered++;
      if (inFinder(c, r)) finderCollision = true;
    }
  }

  const coveredFraction = covered / total;
  const safe = !finderCollision && coveredFraction <= OVERLAY_SAFE_THRESHOLD;
  let reason: string | undefined;
  if (finderCollision) {
    reason = "code overlay overlaps a QR finder pattern — the label will not scan";
  } else if (coveredFraction > OVERLAY_SAFE_THRESHOLD) {
    reason =
      `code overlay covers ${(coveredFraction * 100).toFixed(1)}% of the QR ` +
      `(max ${(OVERLAY_SAFE_THRESHOLD * 100).toFixed(0)}%) — shorten the code or use a larger label`;
  }

  return {
    version: qr.version,
    moduleCount: n,
    totalModules: total,
    coveredModules: covered,
    coveredFraction,
    budget: EC_H_BUDGET,
    safeThreshold: OVERLAY_SAFE_THRESHOLD,
    finderCollision,
    safe,
    reason,
  };
}
