/** Keep one unit when the best catalog photo shows two of them.
 *
 *  A retail listing frequently stages two of the bottle side by side, or ships
 *  a 2-pack. The picture is then the most ACCURATE image of the product and the
 *  wrong image of the ITEM, which is one of them (reported 2026-08-14: "the
 *  selected image is the best/most accurate image but it shows 2 units, not 1").
 *
 *  WHAT THIS IS NOT. It is not a ranking change. The ranker chose correctly and
 *  demoting that photo in favour of a less accurate single-unit shot would
 *  trade the thing that matters for the thing that is easy. The pick stands;
 *  only the framing is corrected.
 *
 *  AND IT COSTS NO VISION CALL. The rank pass is already looking at this
 *  photo to choose it, so it is asked, in the same reply, how many units it
 *  sees and which half holds one. The crop itself is then arithmetic.
 *
 *  A deterministic detector was tried first and measured against generated
 *  layouts before being thrown away. Comparing the halves of the image finds
 *  only a perfectly translated pair (mean diff 0.5) and misses both of the
 *  arrangements a 2-pack actually uses - mirror-placed (25.7) and touching
 *  (43.7) - while firing on two DIFFERENT products (0.8), because greyscale
 *  erases the colour that distinguishes them. It would have cut genuine group
 *  photos in half. The layout question needs eyes; the cut does not.
 */

import sharp from "sharp";
import type { UnitSide } from "./rank-photo.js";

/** How much of the image to keep. Slightly more than half, because two units
 *  usually touch or overlap slightly at the middle and a hard 50% shaves the
 *  near edge off the unit being kept. The catalog trim removes whatever
 *  background this leaves. */
export const KEEP = 0.56;

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The pixel box for one unit on `side`. Pure, so the geometry is testable
 *  without an image. */
export function unitBox(
  size: { width: number; height: number },
  side: UnitSide,
): CropBox | null {
  const { width: w, height: h } = size;
  if (w <= 0 || h <= 0) return null;
  // Cutting across the SHORT axis leaves a sliver. A side-by-side pair is in a
  // frame at least roughly square; a stacked pair is at least roughly as tall.
  if ((side === "left" || side === "right") && w / h < 0.9) return null;
  if ((side === "top" || side === "bottom") && h / w < 0.9) return null;

  const keepW = Math.max(1, Math.round(w * KEEP));
  const keepH = Math.max(1, Math.round(h * KEEP));
  switch (side) {
    case "left":
      return { left: 0, top: 0, width: keepW, height: h };
    case "right":
      return { left: w - keepW, top: 0, width: keepW, height: h };
    case "top":
      return { left: 0, top: 0, width: w, height: keepH };
    case "bottom":
      return { left: 0, top: h - keepH, width: w, height: keepH };
  }
}

/** Crop `input` to the single unit on `side`. Null when the shape makes the cut
 *  unsafe or the bytes will not decode — the full photo is kept, which is only
 *  ever too generous, never wrong. */
export async function cropToUnit(input: Uint8Array, side: UnitSide): Promise<Uint8Array | null> {
  try {
    const meta = await sharp(Buffer.from(input), { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    const box = unitBox({ width: meta.width, height: meta.height }, side);
    if (!box) return null;
    const out = await sharp(Buffer.from(input), { failOn: "none" })
      .extract(box)
      .jpeg({ quality: 90 })
      .toBuffer();
    return new Uint8Array(out);
  } catch {
    return null;
  }
}
