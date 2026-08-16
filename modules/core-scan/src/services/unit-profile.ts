/** Finding two of the same unit in a catalog photo, without a model.
 *
 *  The rank pass answers this when it runs, but it only runs on demand (the
 *  "Pick best" button, or a workspace that turned always-on ranking on). The
 *  FIRST catalog image an item gets never goes through it, so most two-unit
 *  photos would still land uncropped. This is the arithmetic answer for that
 *  case.
 *
 *  A FIRST ATTEMPT WAS MEASURED AND THROWN AWAY, and its failure shaped this
 *  one. Comparing the image's left half to its right half (plain vs mirrored,
 *  to tell a repeat from a symmetry) only finds a pair that happens to be
 *  aligned to the halves:
 *
 *    two identical, translated     plain= 0.5  mirrored= 6.3   found
 *    two identical, mirror-placed  plain=25.7  mirrored= 6.4   MISSED
 *    two identical, touching pair  plain=43.7  mirrored= 6.1   MISSED
 *    two DIFFERENT products        plain= 0.8  mirrored= 6.5   WOULD HAVE CUT
 *
 *  Both misses are the arrangements a 2-pack actually uses, and the last row
 *  would have cut a genuine group photo in half, because greyscale erased the
 *  colour that told the two products apart.
 *
 *  So this measures the thing that actually matters: WHERE THE INK IS. Count
 *  the non-background pixels in each column and you get a profile with one hump
 *  per object, wherever those objects happen to sit. Two humps separated by
 *  clean background is two things; one hump is one thing. Position-independent,
 *  which is exactly what the previous attempt was not.
 *
 *  Then, to tell two of the SAME product from two different ones, the two
 *  regions are compared IN COLOUR. That was the other half of the earlier
 *  failure and it is not repeated here.
 */

import sharp from "sharp";
import { uprightBytes } from "./trim-margins.js";

/** Working width for the profile. Coarse enough to be cheap and to ignore JPEG
 *  noise, fine enough to resolve a gap between two units. */
const W = 200;
const H = 200;

/** A column is "ink" when it differs from the background by more than this. */
const INK_DELTA = 18;

/** A gap must be at least this fraction of the width to separate two units —
 *  narrower than this is a shadow or a label seam, not open background. */
export const MIN_GAP_FRACTION = 0.04;

/** Each unit must occupy at least this fraction of the width, or the "pair" is
 *  an object and a speck. */
export const MIN_BAND_FRACTION = 0.12;

/** The two bands' widths must be within this ratio of each other. */
export const BAND_WIDTH_TOLERANCE = 0.45;

/** Mean per-channel difference below which the two regions are the same
 *  product. Compared in colour, deliberately. */
export const SAME_PRODUCT_MAX_DIFF = 22;

export interface Band {
  start: number;
  end: number;
  /** Vertical extent of the ink WITHIN this band. Measured because comparing
   *  full-height strips dilutes everything with background: two units sitting
   *  at different heights failed to line up, and two DIFFERENT products scored
   *  as similar because the colour that separated them was a minority of the
   *  pixels. Both were measured before this was added. */
  top: number;
  bottom: number;
}

/** Split a column-ink profile into the bands of contiguous ink. */
export function bandsFromProfile(ink: boolean[], minGap: number): Band[] {
  const bands: Band[] = [];
  let start = -1;
  let lastInk = -1;
  let gap = 0;
  for (let x = 0; x < ink.length; x++) {
    if (ink[x]) {
      // A sub-minGap seam inside an open band needs NO special case: a band
      // only CLOSES at minGap, so ink resuming before that simply continues it.
      // (An earlier "reopen the previous band" branch here popped the last
      // closed band instead — bridging the >= minGap gap that legitimately
      // separated it, so a 2-pack whose RIGHT unit had a thin label seam
      // collapsed to one band while the mirrored layout was caught.)
      if (start < 0) start = x;
      lastInk = x;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= minGap) {
        bands.push({ start, end: lastInk, top: 0, bottom: 0 });
        start = -1;
      }
    }
  }
  // Close on the last INK column, not the array edge: a band followed by a
  // sub-minGap tail of background otherwise annexes that background.
  if (start >= 0) bands.push({ start, end: lastInk, top: 0, bottom: 0 });
  return bands.filter((b) => b.end > b.start);
}

/** Is this pair of bands two of the SAME unit, side by side? */
export function bandsLookLikeTwoUnits(bands: Band[], width: number, colourDiff: number): boolean {
  if (bands.length !== 2) return false;
  const [a, b] = bands as [Band, Band];
  const wa = a.end - a.start;
  const wb = b.end - b.start;
  if (wa / width < MIN_BAND_FRACTION || wb / width < MIN_BAND_FRACTION) return false;
  // Two of the same thing are about the same width. A wide object beside a
  // narrow one is a group, not a pair.
  if (Math.abs(wa - wb) / Math.max(wa, wb) > BAND_WIDTH_TOLERANCE) return false;
  return colourDiff <= SAME_PRODUCT_MAX_DIFF;
}

export interface ProfileVerdict {
  bands: Band[];
  colourDiff: number;
  twoUnits: boolean;
}

/** Measure an image: where the ink is, and whether the two regions match. */
export async function profileUnits(input: Uint8Array): Promise<ProfileVerdict | null> {
  try {
    const { data, info } = await sharp(Buffer.from(input), { failOn: "none" })
      .resize(W, H, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    if (ch < 3) return null;

    // Background = the top-left corner, which on a catalog shot is the backdrop.
    const bg = [data[0] ?? 255, data[1] ?? 255, data[2] ?? 255];
    const ink: boolean[] = [];
    for (let x = 0; x < W; x++) {
      let hits = 0;
      for (let y = 0; y < H; y++) {
        const p = (y * W + x) * ch;
        const d =
          Math.abs((data[p] ?? 0) - (bg[0] ?? 0)) +
          Math.abs((data[p + 1] ?? 0) - (bg[1] ?? 0)) +
          Math.abs((data[p + 2] ?? 0) - (bg[2] ?? 0));
        if (d / 3 > INK_DELTA) hits++;
      }
      // A column counts as ink when a real slice of it is foreground, so a
      // stray watermark line does not become a band.
      ink.push(hits > H * 0.05);
    }

    const bands = bandsFromProfile(ink, Math.max(2, Math.round(W * MIN_GAP_FRACTION))).map((b) => {
      // The rows this band's ink actually occupies.
      let top = H;
      let bottom = -1;
      for (let y = 0; y < H; y++) {
        for (let x = b.start; x <= b.end; x++) {
          const p = (y * W + x) * ch;
          const d =
            Math.abs((data[p] ?? 0) - (bg[0] ?? 0)) +
            Math.abs((data[p + 1] ?? 0) - (bg[1] ?? 0)) +
            Math.abs((data[p + 2] ?? 0) - (bg[2] ?? 0));
          if (d / 3 > INK_DELTA) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            break;
          }
        }
      }
      return { ...b, top: Math.min(top, H - 1), bottom: Math.max(bottom, 0) };
    });
    let colourDiff = Number.POSITIVE_INFINITY;
    if (bands.length === 2) {
      colourDiff = await compareBands(input, bands as [Band, Band]);
    }
    return { bands, colourDiff, twoUnits: bandsLookLikeTwoUnits(bands, W, colourDiff) };
  } catch {
    return null;
  }
}

/** Mean per-channel difference between the two banded regions, IN COLOUR.
 *  Both are resampled to one size first, so two units at slightly different
 *  scales still compare. */
async function compareBands(input: Uint8Array, bands: [Band, Band]): Promise<number> {
  const meta = await sharp(Buffer.from(input), { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) return Number.POSITIVE_INFINITY;
  const scale = meta.width / W;
  const N = 48;

  const scaleY = meta.height / 200;
  const crop = async (b: Band): Promise<Buffer> => {
    const left = Math.max(0, Math.floor(b.start * scale));
    const width = Math.max(1, Math.min(meta.width! - left, Math.ceil((b.end - b.start + 1) * scale)));
    const top = Math.max(0, Math.floor(b.top * scaleY));
    const height = Math.max(1, Math.min(meta.height! - top, Math.ceil((b.bottom - b.top + 1) * scaleY)));
    // The band's OWN box: two units at different heights then line up, and the
    // product fills the comparison instead of the backdrop.
    return sharp(Buffer.from(input), { failOn: "none" })
      .extract({ left, top, width, height })
      .resize(N, N, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  };

  const [a, b] = await Promise.all([crop(bands[0]), crop(bands[1])]);
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return len > 0 ? sum / len : Number.POSITIVE_INFINITY;
}

/** Crop to the FIRST unit when the photo holds two of the same, using the
 *  measured band box rather than a blunt half: the profile knows exactly where
 *  the unit starts and stops, which is better information than "the left side".
 *  A little padding, because the box is measured at 200px and the edges of a
 *  soft-shadowed product sit just outside it.
 *
 *  Null whenever it is not certain, which is most of the time. Every refusal
 *  keeps the whole photo, which is only ever too generous, never wrong. */
export async function cropToFirstUnit(input: Uint8Array): Promise<Uint8Array | null> {
  try {
    // Upright first, so the profile, the band boxes and the extract all agree
    // on display space — and so the re-encode below (which strips metadata)
    // cannot store a sideways image.
    const up = await uprightBytes(input);
    if (!up) return null;
    const v = await profileUnits(up.bytes);
    if (!v?.twoUnits || v.bands.length !== 2) return null;
    const band = v.bands[0]!;
    const meta = up.meta;
    if (!meta.width || !meta.height) return null;

    const sx = meta.width / W;
    const sy = meta.height / H;
    const pad = Math.round(Math.max(meta.width, meta.height) * 0.03);
    const left = Math.max(0, Math.floor(band.start * sx) - pad);
    const top = Math.max(0, Math.floor(band.top * sy) - pad);
    const width = Math.min(meta.width - left, Math.ceil((band.end - band.start + 1) * sx) + pad * 2);
    const height = Math.min(meta.height - top, Math.ceil((band.bottom - band.top + 1) * sy) + pad * 2);
    if (width < 8 || height < 8) return null;

    const out = await sharp(up.bytes, { failOn: "none" })
      .extract({ left, top, width, height })
      .jpeg({ quality: 90 })
      .toBuffer();
    return new Uint8Array(out);
  } catch {
    return null;
  }
}
