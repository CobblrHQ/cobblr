// The unified label-media model (D3). A thermal printer has a MEDIA — the physical
// stock currently loaded — and a LABEL FACE — one printable footprint on it. The
// raster single-label footprint the ESC/POS / phomemo path consumes (widthDots /
// labelHeightMm / gapMm) and the mm-native TsplMedia are both PROJECTIONS of this
// one model, so the two geometry models that used to drift apart
// (docs/design-decisions/label-media-and-accumulation.md §3) now share a source.
//
// Internal unit is millimetres — the physical one (§7). Dots are derived per the
// printer's dpi; inches appear only at the PDF boundary, never here.

import { mmToDots, dotsToMm, PHOMEMO_DPI } from "./protocol.js";
import type { TsplDirection, TsplMedia } from "./tspl.js";

/** How the stock advances. `continuous` roll (cut/tear anywhere), `die-cut` labels
 *  separated by a gap, or a fixed `sheet`. Only die-cut has an inter-label gap. */
export type FeedType = "continuous" | "die-cut" | "sheet";

/** The stock loaded in the printer right now — what the user changes on a roll swap. */
export interface LabelMedia {
  widthMm: number;
  heightMm: number;
  feed: FeedType;
  /** Inter-label gap for die-cut stock; 0 for continuous/sheet. */
  gapMm: number;
}

/** One printable label on that media. On a plain thermal printer the face fills the
 *  media width; n-up (a narrower face tiled across a wider media) arrives in slice 3. */
export interface LabelFace {
  widthMm: number;
  heightMm: number;
}

/** The raster single-label footprint. Structurally the geometry subset of
 *  BluetoothPrinterSettings, kept here so the projection has no dependency back on
 *  platform-web. */
export interface ThermalFootprint {
  widthDots: number;
  labelHeightMm: number;
  gapMm: number;
}

/** media + label → the raster footprint (D3). The head images the full media width,
 *  so widthDots is the MEDIA width; the stock advances by one label height; the gap
 *  is the die-cut inter-label space (continuous/sheet have none). */
export function thermalFootprint(
  media: LabelMedia,
  label: LabelFace,
  dpi: number = PHOMEMO_DPI,
): ThermalFootprint {
  return {
    widthDots: mmToDots(media.widthMm, dpi),
    labelHeightMm: label.heightMm,
    gapMm: media.feed === "die-cut" ? media.gapMm : 0,
  };
}

/** How many label faces fit on the media: cols across × rows down, the max-fit
 *  grid. The same arithmetic the PDF path's deriveGrid uses, in mm: N faces need
 *  (N-1) gaps, so N <= (available + gap) / (face + gap). Only die-cut has a gap.
 *  The 1e-9 nudge absorbs binary float dust (a clean 3/1.5 landing at 1.9999). */
export function mediaTiles(media: LabelMedia, label: LabelFace): { cols: number; rows: number } {
  const gap = media.feed === "die-cut" ? media.gapMm : 0;
  const fit = (avail: number, face: number): number =>
    face <= 0 ? 0 : Math.max(0, Math.floor((avail + gap + 1e-9) / (face + gap)));
  return { cols: fit(media.widthMm, label.widthMm), rows: fit(media.heightMm, label.heightMm) };
}

/** media + label → TsplMedia (mm-native, no dots). The TSPL SIZE is the LABEL, not
 *  the whole roll: the printer feeds one label per SIZE/GAP cycle. */
export function tsplMediaFrom(
  media: LabelMedia,
  label: LabelFace,
  opts: { direction: TsplDirection; density?: number; speed?: number; offsetMm?: number },
): TsplMedia {
  return {
    widthMm: media.widthMm,
    heightMm: label.heightMm,
    gapMm: media.feed === "die-cut" ? media.gapMm : 0,
    direction: opts.direction,
    ...(opts.offsetMm != null ? { offsetMm: opts.offsetMm } : {}),
    ...(opts.density != null ? { density: opts.density } : {}),
    ...(opts.speed != null ? { speed: opts.speed } : {}),
  };
}

/** Back-compat: reconstruct a (media, label) from a printer configured BEFORE D3,
 *  whose stored settings are only a footprint. A gap means die-cut; otherwise
 *  continuous. The label face is the full media width by one label height. widthMm
 *  is kept PRECISE (unrounded) so thermalFootprint() reproduces the original
 *  widthDots exactly — the invariant the 1c-B self-heal leans on so migrating an
 *  existing printer never shifts what it prints. */
export function mediaFromFootprint(
  f: { widthDots: number; labelHeightMm?: number; gapMm?: number },
  dpi: number = PHOMEMO_DPI,
): { media: LabelMedia; label: LabelFace } {
  const widthMm = dotsToMm(f.widthDots, dpi);
  // 0 = "no fixed label height" — a continuous roll cut to content length.
  const heightMm = f.labelHeightMm ?? 0;
  const gapMm = f.gapMm ?? 0;
  const feed: FeedType = gapMm > 0 ? "die-cut" : "continuous";
  return {
    media: { widthMm, heightMm, feed, gapMm },
    label: { widthMm, heightMm },
  };
}
