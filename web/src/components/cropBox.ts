// The box a drag across a photo turns into: fractions of the image, the shape
// the catalog-image route's `crop` takes and the split feature's segmentation
// yields, so the server has one cropper for both.

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest side a crop may have, as a fraction of the image. Below this a
 *  drag is a tap, and a tap must never send a sixteen-pixel sliver of a photo
 *  off to become the catalog image. Mirrors the route's `min(0.02)`. */
export const MIN_SIDE = 0.02;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Two screen points and the image's on-screen rect become a fraction box.
 *  Any drag direction works; the box is clamped to the image, so a drag that
 *  runs off the edge crops to the edge rather than failing. Returns null for a
 *  tap or an image with no size. */
export function cropBoxFrom(start: Point, end: Point, rect: Rect): CropBox | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x0 = clamp01((Math.min(start.x, end.x) - rect.left) / rect.width);
  const x1 = clamp01((Math.max(start.x, end.x) - rect.left) / rect.width);
  const y0 = clamp01((Math.min(start.y, end.y) - rect.top) / rect.height);
  const y1 = clamp01((Math.max(start.y, end.y) - rect.top) / rect.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < MIN_SIDE || h < MIN_SIDE) return null;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return { x: r(x0), y: r(y0), w: r(w), h: r(h) };
}
