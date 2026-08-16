/** Make a fetched catalog photo presentable: no black voids, no dead space.
 *
 *  TWO THINGS GO WRONG WITH A WEB PRODUCT SHOT, and both were reported on
 *  2026-08-14 looking at the same card.
 *
 *  1. TRANSPARENCY BECOMES BLACK. A clean cut-out product is very often a PNG
 *     with an alpha channel, and every JPEG encode flattens alpha onto black
 *     unless told otherwise. A box of salt then arrives on the card as a
 *     photograph floating in a black rectangle. Catalog shots are on white by
 *     convention — that is what the image search asks for and what every
 *     neighbouring thumbnail looks like — so alpha is flattened onto WHITE and
 *     the strip stays consistent.
 *
 *  2. THE PRODUCT IS ADRIFT IN EMPTY SPACE. A studio shot frequently puts a
 *     small jar in a large white field: right product, right background, mostly
 *     nothing. The thumbnail is then mostly nothing too, and the item is
 *     unreadable at a glance ("there is all this whitespace").
 *
 *  Deterministic, not a vision call. "Where does the white stop" is arithmetic
 *  over pixels; paying a model to answer it would be slower, cost money and be
 *  less accurate than the exact answer (heuristic-first).
 *
 *  THE MARGIN IS THE POINT. A tight crop looks amputated and, on a photo with a
 *  soft shadow or an anti-aliased edge, genuinely clips the product. So the
 *  trim finds the content box and then puts a margin back in the image's own
 *  background colour, which is why it extends rather than simply cropping less.
 *
 *  It declines more often than it acts, and each refusal is a way this could
 *  make a picture WORSE:
 *
 *   - nothing to gain: a photo already filled by its product, with no alpha,
 *     gets a re-encode and nothing else.
 *   - it ate the picture: a trim leaving a sliver found a gradient or a busy
 *     edge, not a border.
 *   - it will not decode: the original is kept, because a failed trim must
 *     never cost an item its picture.
 */

import sharp, { type Metadata } from "sharp";

/** Bake an EXIF orientation into the pixels, once, up front. Every pipeline in
 *  this family re-encodes with metadata stripped, and a stripped orientation
 *  tag without the rotation baked in stores the image sideways (verified with
 *  an orientation-6 camera JPEG: the trim's output rendered rotated 90° from
 *  what the user saw). It also puts every geometry the callers compute — trim
 *  boxes, band positions, the ranker's left/right answer — in DISPLAY space,
 *  which is the space those answers are actually about. Null when the bytes
 *  will not decode. */
export async function uprightBytes(
  input: Uint8Array,
): Promise<{ bytes: Buffer; meta: Metadata } | null> {
  const raw = Buffer.from(input);
  const meta0 = await sharp(raw, { failOn: "none" }).metadata();
  if (!meta0.width || !meta0.height) return null;
  if ((meta0.orientation ?? 1) === 1) return { bytes: raw, meta: meta0 };
  const bytes = await sharp(raw, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) return null;
  return { bytes, meta };
}

export interface TrimPlan {
  /** Crop to this box (pixels in the SOURCE image), then re-add the margin. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Margin to put back on every side, in pixels. */
  margin: number;
}

/** Fraction of the SHORTER trimmed side to leave as breathing room. */
export const MARGIN_FRACTION = 0.06;

/** Below this, the border is not worth a re-encode: the product already fills
 *  the frame. Expressed as the fraction of total AREA the trim would remove. */
export const MIN_AREA_GAIN = 0.08;

/** A trim leaving less than this fraction of either side has not found a
 *  border; it has found a gradient and eaten the subject. */
export const MIN_REMAINING_SIDE = 0.15;

/** What a catalog image is flattened onto. White, because that is the catalog
 *  convention and what every other thumbnail in the strip already is. */
const CANVAS = { r: 255, g: 255, b: 255 };

/** Decide what to do with a measured content box. Pure, so the judgement is
 *  testable without pixels. */
export function planTrim(
  src: { width: number; height: number },
  content: { left: number; top: number; width: number; height: number },
): TrimPlan | null {
  if (src.width <= 0 || src.height <= 0) return null;
  if (content.width <= 0 || content.height <= 0) return null;

  // Ate the picture → whatever it measured was not a border.
  if (content.width / src.width < MIN_REMAINING_SIDE) return null;
  if (content.height / src.height < MIN_REMAINING_SIDE) return null;

  // Not enough dead space to be worth touching the file.
  const gain = 1 - (content.width * content.height) / (src.width * src.height);
  if (gain < MIN_AREA_GAIN) return null;

  const margin = Math.max(2, Math.round(Math.min(content.width, content.height) * MARGIN_FRACTION));
  return { left: content.left, top: content.top, width: content.width, height: content.height, margin };
}

/** Flatten transparency onto white and trim dead space. Returns the new bytes,
 *  or null when the image is better left exactly as it is. */
export async function trimCatalogMargins(input: Uint8Array): Promise<Uint8Array | null> {
  try {
    const up = await uprightBytes(input);
    if (!up) return null;
    const { bytes: base, meta } = up;
    if (!meta.width || !meta.height) return null;

    // FLATTEN FIRST, and measure the flattened image. A transparent PNG's
    // pixels under the alpha are usually black, so measuring before flattening
    // finds a "border" of black and then paints the margin black — the exact
    // void this exists to prevent.
    const flat = meta.hasAlpha
      ? await sharp(base, { failOn: "none" }).flatten({ background: CANVAS }).png().toBuffer()
      : base;

    const probe = await sharp(flat, { failOn: "none" })
      .trim({ threshold: 12 })
      .toBuffer({ resolveWithObject: true });
    const plan = planTrim(
      { width: meta.width, height: meta.height },
      {
        left: -(probe.info.trimOffsetLeft ?? 0),
        top: -(probe.info.trimOffsetTop ?? 0),
        width: probe.info.width,
        height: probe.info.height,
      },
    );

    // Nothing to fix: no transparency to lose and no space worth reclaiming.
    if (!plan && !meta.hasAlpha) return null;

    let pipeline = sharp(flat, { failOn: "none" });
    if (plan) {
      const bg = await cornerColour(flat);
      pipeline = pipeline
        .extract({ left: plan.left, top: plan.top, width: plan.width, height: plan.height })
        // Extend rather than crop-less: the margin goes on in the background's
        // own colour, so a product whose edge touches the content box keeps its
        // air even when the original border was lopsided.
        .extend({
          top: plan.margin,
          bottom: plan.margin,
          left: plan.margin,
          right: plan.margin,
          background: bg,
        });
    }
    return new Uint8Array(await pipeline.jpeg({ quality: 90 }).toBuffer());
  } catch {
    return null; // a decode failure must never cost the item its picture
  }
}

/** The image's own corner colour — what its border is made of. Read from the
 *  ALREADY-FLATTENED bytes, so it is a real colour rather than whatever sat
 *  beneath a transparent pixel. */
async function cornerColour(flat: Buffer): Promise<{ r: number; g: number; b: number }> {
  try {
    const { data } = await sharp(flat, { failOn: "none" })
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { r: data[0] ?? 255, g: data[1] ?? 255, b: data[2] ?? 255 };
  } catch {
    return CANVAS;
  }
}
