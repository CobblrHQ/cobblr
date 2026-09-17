// A long thin thing in a tall narrow frame: turn the thumbnail, never the
// picture (#3059 Engine 4, #3066).
//
// A screwdriver photographed lying down is four times wider than it is
// tall. The phone row's thumbnail column is 64px wide and the row about
// 128px tall, so the screwdriver renders 64 by 16, a sliver, and the
// reviewer could not tell one driver bit from another. Turned a quarter,
// the same picture runs 128px along its length, twice the size, and reads
// at a glance. The owner asked whether the whitespace trim that already runs on
// every catalog picture could be followed by "a 90 degree rotation for
// better aspect ratio in this scenario of the long and skinny items", as a
// proposal to assess, not a licence to rotate every image.
//
// Assessed: the turn helps only where the FRAME is taller than it is wide
// and the picture is much wider than it is tall. A square frame gains
// nothing (64 by 16 becomes 16 by 64); the desktop card's column (112 by up
// to 128) gains a seventh, not worth the disorientation. So this is a
// measure of the fit, and a turn is taken only when it wins by half again.
//
// Two things are never turned, whatever the fit: packaging with text on it
// (a box lying flat is read by its words, and sideways words are worse than
// a small picture; the identify pass's `packaging` says when a box is in
// frame), and a titled work (a book's cover is text). And it is display only:
// the stored picture keeps its orientation, the lightbox shows it as taken,
// and a person's own Rotate makes a new picture whose aspect this then reads
// as it is, which is the override.

/** The size a frame allows: a fixed width and a height the image may take
 *  up to. The phone row's thumbnail is `{ width: 64, maxHeight: 128 }`. */
export interface ThumbFrame {
  width: number;
  maxHeight: number;
}

export interface ThumbFit {
  /** Degrees to turn the thumbnail for display: 0 or 90. */
  rotate: 0 | 90;
  /** How much longer the picture's long side renders when turned, against
   *  not turned: 2 for the screwdriver in the phone row, 1 for a square. */
  gain: number;
}

/** A picture this much wider than tall is a long thin thing. */
export const LONG_THIN_ASPECT = 2.5;
/** The turn must render the long side at least this much longer. */
export const MIN_ROTATE_GAIN = 1.5;

/** The rendered long side of a w by h picture contained in the frame. */
function longSide(w: number, h: number, frame: ThumbFrame): number {
  const scale = Math.min(frame.width / w, frame.maxHeight / h);
  return Math.max(w, h) * scale;
}

/**
 * Whether to turn a thumbnail, from the picture's natural size and the
 * frame it sits in. `textHeavy` says the picture is read by its words
 * (packaging in frame, a titled work) and is never turned.
 */
export function thumbnailFit(
  image: { width: number; height: number },
  frame: ThumbFrame,
  opts: { textHeavy?: boolean } = {},
): ThumbFit {
  const { width: w, height: h } = image;
  if (!(w > 0) || !(h > 0) || !(frame.width > 0) || !(frame.maxHeight > 0)) return { rotate: 0, gain: 1 };
  const flat = longSide(w, h, frame);
  const turned = longSide(h, w, frame);
  const gain = flat > 0 ? turned / flat : 1;
  if (opts.textHeavy) return { rotate: 0, gain };
  if (w / h < LONG_THIN_ASPECT) return { rotate: 0, gain };
  return gain >= MIN_ROTATE_GAIN ? { rotate: 90, gain } : { rotate: 0, gain };
}

/** Is this row's picture read by its words? Packaging in frame (the
 *  identify pass's `packaging`: box, sealed, opened), or a titled work (a
 *  title's variants, a creator read off the cover). */
export function thumbnailTextHeavy(meta: unknown): boolean {
  const m = (meta ?? {}) as { packaging?: unknown; title_variants?: unknown; photo_read?: { creator?: unknown } | null };
  if (typeof m.packaging === "string" && /^(box|sealed|opened)$/.test(m.packaging)) return true;
  if (m.title_variants && typeof m.title_variants === "object") return true;
  if (m.photo_read && typeof m.photo_read === "object" && typeof m.photo_read.creator === "string" && m.photo_read.creator.trim()) return true;
  return false;
}
