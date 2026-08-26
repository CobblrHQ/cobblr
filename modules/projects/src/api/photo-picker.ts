// Which of a PDF's embedded images is the finished object — and whether any of
// them is, which is the question the old picker could not ask.
//
// "The largest image" was measured against a corpus of 26 real PDFs
// (e2e/fixtures/pattern-photo-corpus/scoreboard.json) and it picks a LOGO on
// every maker guide, a chart on every datasheet, and the photo only on PDFs
// laid out to make the photo biggest. Size does not know what a picture is of.
//
// TWO SIGNALS MAKE THE FLOOR, and neither was the obvious one:
//
//   SATURATION rejects grey: line art, charts, logos, screenshots. Every
//   photograph in the corpus is ≥ 0.03, every grey non-photo ≤ 0.01.
//
//   SMOOTHNESS rejects coloured flat art, which saturation lets straight
//   through: a cartoon (0.08), a pinout illustration (0.18), a schematic with
//   red and blue wires (0.04). What those lack is GRADIENT — a drawing is flat
//   runs broken by hard edges, so almost no neighbouring pixels differ by a
//   little; a photograph is grain and shading, so most do. Every hero photo
//   scores ≥ 0.31; every coloured non-photo ≤ 0.26.
//
// The signals that did NOT work, recorded so nobody re-tries them: colour
// ENTROPY (a real board photo scores 3.6, a line chart 4.9), FLAT-REGION share
// (a product shot on a white sweep is 64% flat and still the photo), and
// PALETTE size (the coloured schematic has exactly as many colours as the
// Prusa product shot). They survive below only as blank-and-tint sanity bounds.
//
// The known cost: a black-and-white photograph fails the floor and nothing is
// attached. That is the deliberate side to err on — the issue's rule is "attach
// only above the floor; below it, attach nothing" — because a grey line
// drawing auto-attached as the design's photo is worse than an empty slot with
// a button that reveals the alternatives.

import type { ExtractedImage } from "./pdf-images.js";
import { photoMetrics, type PhotoMetrics } from "./photo-metrics.js";

/** Below this mean chroma an image is grey: line art, a chart, a logo, a
 *  screenshot. Every photograph in the corpus is ≥ 0.03; every non-photo is
 *  ≤ 0.01. Set at the midpoint so a scan that drifts either way still lands. */
export const MIN_SATURATION = 0.02;
/** Below this the histogram is a blank with a tint, not a picture. Set low on
 *  purpose: it is not the discriminator (a chart scores 4.9, a real photo of a
 *  green board 3.6), it only has to reject a flat wash. A clean PNG cutout on
 *  pure white can legitimately score ~2.5 and still be the finished object. */
export const MIN_ENTROPY = 2.0;
/** Above this share of one tone there is no subject in the frame. The flattest
 *  real photo in the corpus (a board on a grey sweep) is 0.64; a small cutout
 *  on paper can reach 0.8 and still be the finished object. */
export const MAX_FLAT = 0.9;
/** Below this share of gently-differing neighbours the image is flat art, not
 *  continuous tone. Corpus: hero photos 0.31–0.64; coloured drawings 0.17–0.26.
 *  Set just under the lowest photo. A small photo cut out on a plain sweep can
 *  score under this too (0.18) — those are never the largest photo in a PDF
 *  that has a real one, and the strip still offers them by hand. */
export const MIN_SMOOTH = 0.28;

export interface ScoredImage {
  image: ExtractedImage;
  /** The extractor's own index, so a caller can point back at the strip. */
  index: number;
  metrics: PhotoMetrics;
  /** Passed the floor: this is a photograph, not a diagram. */
  photo: boolean;
}

export function isPhoto(m: PhotoMetrics): boolean {
  return (
    m.saturation >= MIN_SATURATION &&
    m.smooth >= MIN_SMOOTH &&
    m.entropy >= MIN_ENTROPY &&
    m.flat <= MAX_FLAT
  );
}

/**
 * Score every candidate and pick the hero.
 *
 * `hero` is the LARGEST image that passes the floor, or null when none does —
 * never the least-bad diagram. Among photographs size still decides: the
 * finished object is the picture the layout gave the most room to, and on
 * every corpus PDF with more than one photo that held.
 */
export async function pickPhoto(images: ExtractedImage[]): Promise<{
  hero: ScoredImage | null;
  scored: ScoredImage[];
}> {
  const scored: ScoredImage[] = [];
  for (const [index, image] of images.entries()) {
    const metrics = await photoMetrics(image.png);
    scored.push({ image, index, metrics, photo: isPhoto(metrics) });
  }
  // Input is largest-first already; the first photograph is the largest one.
  const hero = scored.find((s) => s.photo) ?? null;
  return { hero, scored };
}
