// Self-calibration — because cheap printers lie about their geometry and many
// stub out the calibration command entirely (a POLONO PM220S silently ignores
// TSPL GAPDETECT), leaving the user with content that walks off the label.
//
// The trick: PRINT THE RULER. A calibration card carries a numbered scale down
// from the top edge, so the user needs no measuring tool — they read back the
// smallest number they can actually see. That single number is the dead zone.
// Print the card twice and the CHANGE in that number is the per-label drift,
// which yields the true media pitch:
//
//     truePitch = pitchWeAssumed + driftPerLabel
//
// Worked from real hardware (PM220S): we assumed 30 mm label + 2 mm gap = 32 mm;
// the topmost visible mark moved 3 mm → 4 mm across two labels, so drift = 1 mm
// and the true pitch is 33 mm. Two questions, no ruler, no printer support.

import { tsplBar, tsplText, encodeTspl, mmToDotsTspl, type TsplMedia } from "./tspl.js";

/** Marks are printed every `stepMm` from the top edge, each labelled with its
 *  distance in mm, so a user can name the topmost one that survived. */
export interface CalibrationCardOptions {
  media: TsplMedia;
  /** How far down to run the scale. Default 10 mm covers any plausible dead zone. */
  spanMm?: number;
  stepMm?: number;
  /** Printed on the card so a photo of it is self-describing. */
  note?: string;
}

const DOTS_PER_MM = 8; // 203 dpi

export function calibrationCardBody(o: CalibrationCardOptions): string {
  const { spanMm = 10, stepMm = 1 } = o;
  const widthDots = mmToDotsTspl(o.media.widthMm);
  // Numerals live in TWO alternating right-hand columns. Marks are only
  // stepMm*8 dots apart (8 dots at 1 mm) while font "1" is 12 dots TALL, so a
  // single column overlaps into unreadable mush. Staggering evens/odds gives
  // each column 16 dots of pitch for a 12-dot glyph while keeping full 1 mm
  // resolution — better than coarsening the scale to every 2 mm.
  // Sit the numerals just right of the LONGEST tick: the ruler stays packed
  // against the left edge and the rest of the label is left clean, so a
  // calibration label is still reusable for a real print.
  const maxTick = 160;
  const numX = Math.min(maxTick + 16, Math.max(0, widthDots - 28));
  const numXAlt = numX + 26;
  let body = "";
  let i = 0;
  for (let mm = 0; mm <= spanMm; mm += stepMm, i++) {
    const y = Math.round(mm * DOTS_PER_MM);
    // tick length shrinks with distance so the scale is readable even if the
    // numerals are clipped — length alone identifies the mark.
    const len = Math.max(24, maxTick - mm * 12);
    body += tsplBar(0, y, len, 2);
    // NOTE: no vertical centering offset. Clamping a negative y at the top mark
    // compressed that column's first gap to 10 dots — under the 12-dot glyph
    // height — so 0 and 2 overlapped. Aligning to the tick keeps every gap 16.
    body += tsplText(String(mm), { x: i % 2 === 0 ? numX : numXAlt, y, font: "1" });
  }
  if (o.note) body += tsplText(o.note, { x: 8, y: Math.round((spanMm + 4) * DOTS_PER_MM), font: "1" });
  return body;
}

/** A full calibration card job. Print it, then read back the topmost visible number. */
export function calibrationCard(o: CalibrationCardOptions): Uint8Array {
  return encodeTspl(o.media, calibrationCardBody(o));
}

export interface CalibrationReadings {
  /** label + gap in mm that we TOLD the printer (SIZE height + GAP). */
  assumedPitchMm: number;
  /** Topmost visible mark on the first card, in mm. */
  firstCardTopMm: number;
  /** Topmost visible mark on the last card, in mm. */
  lastCardTopMm: number;
  /** How many cards were printed (>= 2 to measure drift). */
  cardsPrinted: number;
}

export interface CalibrationResult {
  /** Dead zone / registration offset at the top of every label, in mm. */
  topMarginMm: number;
  topMarginDots: number;
  /** How far the image walks per label with the assumed pitch (0 = registered). */
  driftPerLabelMm: number;
  /** The pitch to actually use: assumed + drift. */
  truePitchMm: number;
  /** Suggested GAP given a known label height (pitch − label height). */
  suggestedGapMm: (labelHeightMm: number) => number;
  /** True when nothing needs changing. */
  registered: boolean;
}

/** Turn the human's two readings into real geometry. */
export function solveCalibration(r: CalibrationReadings): CalibrationResult {
  if (r.cardsPrinted < 1) throw new Error("cardsPrinted must be >= 1");
  const spans = r.cardsPrinted - 1;
  // With one card we can still learn the dead zone, just not the drift.
  const driftPerLabelMm = spans > 0 ? (r.lastCardTopMm - r.firstCardTopMm) / spans : 0;
  const truePitchMm = r.assumedPitchMm + driftPerLabelMm;
  const topMarginMm = r.firstCardTopMm;
  return {
    topMarginMm,
    topMarginDots: Math.round(topMarginMm * DOTS_PER_MM),
    driftPerLabelMm,
    truePitchMm,
    suggestedGapMm: (labelHeightMm: number) => Number((truePitchMm - labelHeightMm).toFixed(2)),
    // sub-0.5mm drift is below what a user can read off the card anyway
    registered: Math.abs(driftPerLabelMm) < 0.5 && topMarginMm <= 1,
  };
}

/** One calibration attempt: the pitch we told the printer, and the drift it showed. */
export interface CalibrationTrial {
  assumedPitchMm: number;
  driftPerLabelMm: number;
}

/** Interpolate two trials to the pitch where drift would be ZERO.
 *
 *  One trial only tells you the drift is wrong, not by how much — the response
 *  isn't exactly 1:1 in practice (media slip, sensor threshold). Two trials that
 *  BRACKET zero (opposite drift signs) pin it precisely. Real PM220S data:
 *  pitch 32 → +1.0 mm/label, pitch 33 → −0.5 mm/label ⇒ true pitch ≈ 32.67 mm. */
export function refinePitch(a: CalibrationTrial, b: CalibrationTrial): number {
  const dd = a.driftPerLabelMm - b.driftPerLabelMm;
  if (Math.abs(dd) < 1e-9) return a.assumedPitchMm;      // no signal to interpolate on
  const pitch = a.assumedPitchMm + (a.driftPerLabelMm * (b.assumedPitchMm - a.assumedPitchMm)) / dd;
  return Number(pitch.toFixed(2));
}

/** True when two trials sit on opposite sides of zero drift, so refinePitch
 *  interpolates rather than extrapolates (much more trustworthy). */
export function brackets(a: CalibrationTrial, b: CalibrationTrial): boolean {
  return a.driftPerLabelMm === 0 || b.driftPerLabelMm === 0 ||
    Math.sign(a.driftPerLabelMm) !== Math.sign(b.driftPerLabelMm);
}

/** Human-readable summary for a support ticket / the harness log. */
export function describeCalibration(c: CalibrationResult, labelHeightMm?: number): string {
  const parts = [
    `top margin ${c.topMarginMm} mm (${c.topMarginDots} dots)`,
    `drift ${c.driftPerLabelMm.toFixed(2)} mm/label`,
    `true pitch ${c.truePitchMm.toFixed(2)} mm`,
  ];
  if (labelHeightMm != null) parts.push(`→ set GAP ${c.suggestedGapMm(labelHeightMm)} mm`);
  return (c.registered ? "registered ✓ — " : "needs correction — ") + parts.join(", ");
}
