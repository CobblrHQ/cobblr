// Is a photo too blurry to read? Measured, not asked (#8796).
//
// A blurred photo of a paprika jar came back "The AI saw no single item to
// name in this photo" with "read it as a receipt" as its way forward. There
// was one item; it was out of focus, and nothing said so. Blur is cheap to
// measure on the pixels, so when the AI finds nothing the row can say why.
//
// The measure is the spread of the Laplacian (how much each pixel differs
// from its neighbours) on the upright picture brought to 512 px. Sharp
// product photos measured 200 to 1,800; the same photos blurred by 2 px or
// more, under 10. A picture with no contrast at all (a blank page) is not
// blurry, it is empty, and one with no edges at all (a flat drawing) is not
// a photo out of focus: a camera's own noise always leaves some.

import sharp from "sharp";
import { uprightBytes } from "./trim-margins.js";

/** Below this spread of the Laplacian, a photo is out of focus. */
export const BLUR_EDGES_BELOW = 10;
/** A picture with less contrast than this is empty, not blurry. */
export const BLUR_MIN_CONTRAST = 8;

export async function photoSharpness(bytes: Buffer): Promise<{ edges: number; contrast: number } | null> {
  try {
    const up = await uprightBytes(bytes);
    const grey = sharp(up?.bytes ?? bytes).greyscale().resize(512, 512, { fit: "inside", withoutEnlargement: true });
    const contrast = (await grey.clone().stats()).channels[0]?.stdev ?? 0;
    const { data } = await grey.clone().convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] }).raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    let sq = 0;
    for (const v of data) {
      sum += v;
      sq += v * v;
    }
    const mean = sum / data.length;
    return { edges: sq / data.length - mean * mean, contrast };
  } catch {
    return null;
  }
}

/** True only for a photo with something in it and its edges smeared. A
 *  picture that cannot be read as an image is never called blurry. */
export async function photoTooBlurry(bytes: Buffer): Promise<boolean> {
  const m = await photoSharpness(bytes);
  return !!m && m.contrast >= BLUR_MIN_CONTRAST && m.edges > 0 && m.edges < BLUR_EDGES_BELOW;
}
