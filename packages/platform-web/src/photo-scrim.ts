// How dark a wash a photo needs before light text can sit on it.
//
// A constant cannot work, because the scrim's job is relative to the image: a
// dark photo needs almost none and a bright one needs a lot. So it is measured.
//
// See docs/design-decisions/assorted-contents.md.

/** Luminance the composite should land on for light text to be readable.
 *  Calibrated, not invented: 0.75 scrim was chosen by eye on a reference photo
 *  whose 90th-percentile luminance is 0.59, and solving back gives 0.24. */
export const TARGET_LUMA = 0.24;

/** The panel colour the scrim is made of (slate-800 #1E293B). */
export const SCRIM_LUMA = 0.12;

export const MIN_SCRIM = 0.12;
export const MAX_SCRIM = 0.92;

/**
 * Solve for the scrim alpha that lands `photoLuma` on TARGET_LUMA:
 *
 *     composite = photo * (1 - a) + scrim * a = TARGET
 *
 * A photo already darker than the target needs nothing, and the clamp keeps a
 * pathological image from producing an opaque slab or a useless wash.
 */
export function scrimAlpha(photoLuma: number): number {
  if (!Number.isFinite(photoLuma)) return 0.75;
  const denom = photoLuma - SCRIM_LUMA;
  if (denom <= 0) return MIN_SCRIM; // already at or below the panel colour
  return Math.max(MIN_SCRIM, Math.min(MAX_SCRIM, (photoLuma - TARGET_LUMA) / denom));
}

/**
 * The 90th-percentile luminance of an image, NOT the mean.
 *
 * This is the whole trick. Legibility is decided by the BRIGHT PATCHES a label
 * lands on (a white cable bag, a chrome shell), not by the average. The
 * reference photo averages 0.31 while carrying spots near 0.90: the mean says
 * "you barely need a scrim" for an image that plainly needs one.
 */
export function percentileLuma(data: Uint8ClampedArray, percentile = 0.9): number {
  const lums: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    lums.push((0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255);
  }
  if (lums.length === 0) return 0.5;
  lums.sort((a, b) => a - b);
  return lums[Math.min(lums.length - 1, Math.floor(lums.length * percentile))]!;
}

/**
 * Measure an image and return the scrim alpha it needs. Falls back to a sane
 * default rather than throwing: a card that cannot sample its own photo (a
 * cross-origin URL taints the canvas) should still be readable.
 */
export async function scrimAlphaFor(src: string): Promise<number> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0.75;
    ctx.drawImage(img, 0, 0, 64, 48);
    return scrimAlpha(percentileLuma(ctx.getImageData(0, 0, 64, 48).data));
  } catch {
    return 0.75;
  }
}
