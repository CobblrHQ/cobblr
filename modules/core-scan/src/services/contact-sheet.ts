// ONE image instead of ten: the candidate photos composed into a numbered
// contact sheet (reported 2026-07-30 — "a single gallery of 9 images so it was only
// sending a single image to the AI").
//
// The first cut sent the reference photo + 9 candidates as 10 separate
// attachments. A single sheet is better on every axis that matters here:
//   • COST — one image instead of ten, which is the whole price of this feature.
//   • REACH — it needs only the single-image plumbing every provider adapter
//     already has for identify-image. The 10-attachment version required
//     multi-image support in each adapter, and the two that lacked it are the
//     ones a real workspace was using (the edge bridge), so the button could
//     only fail there.
//   • COLOUR — the user's own photo sits in the same frame as the candidates,
//     so the model compares colour side by side instead of across attachments.
//   • NO INDEX HAZARD — tiles are positions in one picture, so there is no
//     "attachment 0 is the reference" offset to get wrong.
//
// Tile numbers are burned in as SVG text. That needs a font IN THE IMAGE: the
// runtime is node:22-alpine, which shipped with no fonts at all (verified in the
// deployed container: SVG text rendered blank + a fontconfig error), so
// api.Dockerfile now installs ttf-dejavu + fontconfig. The prompt ALSO states
// the reading order (left to right, top to bottom), so a sheet whose labels
// somehow fail to render is still interpretable by position.

import sharp from "sharp";

/** One image to place on the sheet. */
export interface SheetImage {
  b64: string;
  mediaType?: string;
}

export interface ContactSheet {
  /** The composed sheet, base64 JPEG. */
  b64: string;
  mediaType: "image/jpeg";
  /** How many numbered candidate tiles it carries (1..tiles). */
  tiles: number;
  cols: number;
  rows: number;
  /** Whether a reference strip was placed above the grid. */
  hasReference: boolean;
}

const TILE = 400; // px per candidate tile — ~400px is plenty to judge colour and "is a person in frame"
const COLS = 3;
const REF_H = 300; // the reference strip is full-width and shorter, so it can't read as a tile
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** A number badge: white box + the numeral, drawn at a tile's top-left. Sized
 *  generously so it survives the model's own downscaling. */
function badge(n: number): Buffer {
  const s = 74;
  return Buffer.from(
    `<svg width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${s}" height="${s}" fill="white" stroke="black" stroke-width="4"/>` +
      `<text x="${s / 2}" y="${s - 16}" font-family="DejaVu Sans, sans-serif" font-size="54" ` +
      `font-weight="bold" fill="black" text-anchor="middle">${n}</text>` +
      `</svg>`,
  );
}

/** Letterbox one image into a WxH white tile — `contain`, never cropped, so a
 *  tall bottle or a wide tote keeps its real shape (the shape IS a signal). */
async function fit(b64: string, w: number, h: number): Promise<Buffer | null> {
  try {
    return await sharp(Buffer.from(b64, "base64"), { failOn: "none" })
      .resize(w, h, { fit: "contain", background: WHITE })
      .toBuffer();
  } catch {
    return null; // an unreadable candidate simply doesn't get a tile
  }
}

/**
 * Compose the candidates (and optionally the user's own photo) into one sheet.
 *
 * Layout, fixed so the prompt can describe it exactly:
 *
 *     [ the user's own photo, full width ]   <- only when `reference` is given
 *     [ 1 ] [ 2 ] [ 3 ]
 *     [ 4 ] [ 5 ] [ 6 ]
 *     [ 7 ] [ 8 ] [ 9 ]
 *
 * Returns null when not a single candidate could be decoded.
 */
export async function composeContactSheet(opts: {
  candidates: SheetImage[];
  reference?: SheetImage | null;
}): Promise<ContactSheet | null> {
  const tiles = await Promise.all(opts.candidates.map((c) => fit(c.b64, TILE, TILE)));
  const usable = tiles.filter((t): t is Buffer => !!t);
  if (usable.length === 0) return null;

  const cols = Math.min(COLS, usable.length);
  const rows = Math.ceil(usable.length / COLS);
  const gridW = cols * TILE;
  const refBuf = opts.reference ? await fit(opts.reference.b64, gridW, REF_H) : null;
  const topOffset = refBuf ? REF_H : 0;

  const layers: sharp.OverlayOptions[] = [];
  if (refBuf) layers.push({ input: refBuf, left: 0, top: 0 });
  usable.forEach((buf, i) => {
    const left = (i % COLS) * TILE;
    const top = topOffset + Math.floor(i / COLS) * TILE;
    layers.push({ input: buf, left, top });
    // 1-based, matching what the prompt tells the model to answer with.
    layers.push({ input: badge(i + 1), left: left + 8, top: top + 8 });
  });

  const out = await sharp({
    create: { width: gridW, height: topOffset + rows * TILE, channels: 3, background: WHITE },
  })
    .composite(layers)
    .jpeg({ quality: 82 })
    .toBuffer();

  return {
    b64: out.toString("base64"),
    mediaType: "image/jpeg",
    tiles: usable.length,
    cols,
    rows,
    hasReference: !!refBuf,
  };
}
