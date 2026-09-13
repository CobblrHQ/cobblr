// Image operations on a scan item's own photo — rotate + split-a-group-photo
// (scan-parity-final-mile.md, Epic B). sharp is the same version core-files
// ships, so no new native binary lands in the api image.
//
// Both ops read via platform().files.read and write NEW files via
// platform().files.write — originals are never mutated in place, so nothing
// is destroyed (rotate keeps the old id in metadata.extra_photos; split's
// parent keeps its photo and is soft-resolved, restorable).

import sharp from "sharp";
import { platform } from "@cobblr/platform-contract";
import { uprightBytes } from "./trim-margins.js";

/** Read a file's ORIGINAL bytes (fall back to medium if original is gone). */
async function readBytes(orgId: string, fileId: string): Promise<{ buf: Buffer; mime: string } | null> {
  const f =
    (await platform().files.read(orgId, fileId, "original")) ??
    (await platform().files.read(orgId, fileId, "medium"));
  if (!f) return null;
  return { buf: Buffer.from(f.bytes), mime: f.mimeType };
}

/** Rotate a stored image by deg (90/180/270) → a NEW file id. */
export async function rotateImage(orgId: string, fileId: string, deg: 90 | 180 | 270): Promise<string | null> {
  const src = await readBytes(orgId, fileId);
  if (!src) return null;
  const out = await sharp(src.buf, { failOn: "none" }).rotate(deg).jpeg({ quality: 90 }).toBuffer();
  const written = await platform().files.write(orgId, out, {
    filename: `rotated-${deg}-${fileId}.jpg`,
    mimeType: "image/jpeg",
  });
  return written?.fileId ?? null;
}

export interface SplitBox {
  /** 0–1 fractions of the source image AS DISPLAYED (see cropBytes). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixels of the crop inside the displayed frame. */
export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CropRefusal =
  /** The bytes did not decode. */
  | "undecodable"
  /** The box covers too little of the frame to be a thing. */
  | "box-too-small"
  /** The box covers nearly the whole frame: not a crop, the photo itself. */
  | "box-too-large"
  /** The cut came out near-uniform: a flat patch of dark, white or grey. */
  | "flat";

export type CropResult =
  | { ok: true; bytes: Buffer; region: CropRegion; frame: { width: number; height: number } }
  | { ok: false; reason: CropRefusal; region: CropRegion | null; frame: { width: number; height: number } | null };

/** A box below this share of the frame is a sliver, above it the whole photo. */
export const CROP_MIN_AREA = 0.02;
export const CROP_MAX_AREA = 0.95;
/** A crop whose brightest channel varies less than this (0..255 standard
 *  deviation) shows nothing: a flat patch of table, wall or shadow. Measured
 *  on the two-sets fixtures: a box on either set reads 40 to 80; a box on
 *  the bare table gradient reads about 9; a black frame reads 0. */
export const CROP_FLAT_STDEV = 12;

/** Cut a fraction box out of an image, in the frame the box was drawn on.
 *
 *  The box comes from something that LOOKED at the picture (a model, a person
 *  dragging on the screen), and what they looked at was the picture as
 *  displayed. A phone photo stores its raster sideways with an orientation
 *  tag, so the displayed frame and the stored one differ by a quarter turn;
 *  a cut on the stored pixels lands on a different part of the scene (the
 *  dark table beside two boxed sets, 2026-09-13). uprightBytes bakes the
 *  turn in first, the same rule the catalog trim and the unit crop follow.
 *
 *  And the cut is looked at before it is trusted: a box that covers a
 *  sliver or the whole frame, or a cut with nothing in it, is refused with
 *  its reason rather than written as somebody's photo.
 *
 *  `pad` widens the box by that fraction of its own size on each side, and
 *  defaults to 5% for the SPLIT case it was written for: a box drawn tightly
 *  around one object in a group photo reads better with a little air, and the
 *  neighbouring pixels are more of the same scene.
 *
 *  A SCREENSHOT region is the opposite situation and passes 0. There the box is
 *  the page's own photo rectangle, so the pixels just outside it are the page
 *  chrome the crop exists to remove — 5% pulled a sliced-off strip of the
 *  listing title into the bottom of the catalog image, which was visible in the
 *  output before anyone looked at the numbers. */
export async function cropBytes(
  input: Uint8Array,
  box: SplitBox,
  opts: { pad?: number } = {},
): Promise<CropResult> {
  const up = await uprightBytes(input);
  if (!up) return { ok: false, reason: "undecodable", region: null, frame: null };
  const W = up.meta.width ?? 0;
  const H = up.meta.height ?? 0;
  if (!W || !H) return { ok: false, reason: "undecodable", region: null, frame: null };
  const frame = { width: W, height: H };
  const area = Math.max(0, box.w) * Math.max(0, box.h);
  const region = cropRegionFor(W, H, box, opts.pad ?? 0.05);
  if (area < CROP_MIN_AREA) return { ok: false, reason: "box-too-small", region, frame };
  if (area > CROP_MAX_AREA) return { ok: false, reason: "box-too-large", region, frame };
  const bytes = await sharp(up.bytes, { failOn: "none" }).extract(region).jpeg({ quality: 90 }).toBuffer();
  const stats = await sharp(bytes).stats();
  const spread = Math.max(...stats.channels.map((c) => c.stdev));
  if (spread < CROP_FLAT_STDEV) return { ok: false, reason: "flat", region, frame };
  return { ok: true, bytes, region, frame };
}

/** The crop's pixels for a fraction box: padded, clamped, never thinner than 16. */
export function cropRegionFor(W: number, H: number, box: SplitBox, pad: number): CropRegion {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp01(box.x - pad * box.w);
  const y0 = clamp01(box.y - pad * box.h);
  const x1 = clamp01(box.x + box.w * (1 + pad));
  const y1 = clamp01(box.y + box.h * (1 + pad));
  const left = Math.min(Math.round(x0 * W), W - 16);
  const top = Math.min(Math.round(y0 * H), H - 16);
  const width = Math.min(Math.max(16, Math.round((x1 - x0) * W)), W - left);
  const height = Math.min(Math.max(16, Math.round((y1 - y0) * H)), H - top);
  return { left, top, width, height };
}

/** The refusal, as a clause for a message. */
export function cropRefusalWords(reason: CropRefusal | "no-source" | "write-failed"): string {
  switch (reason) {
    case "undecodable": return "the photo could not be read";
    case "box-too-small": return "the region is too small to be a thing";
    case "box-too-large": return "the region is nearly the whole photo";
    case "flat": return "that region shows nothing";
    case "no-source": return "the photo is missing";
    case "write-failed": return "the crop could not be saved";
  }
}

export type CropOutcome =
  | { fileId: string; region: CropRegion; frame: { width: number; height: number } }
  | { fileId: null; reason: CropRefusal | "no-source" | "write-failed"; region: CropRegion | null; frame: { width: number; height: number } | null };

/** Crop one region of a stored image → a NEW file id, or the reason there is
 *  none. The source file is never touched. */
export async function cropRegion(
  orgId: string,
  fileId: string,
  box: SplitBox,
  opts: { pad?: number } = {},
): Promise<CropOutcome> {
  const src = await readBytes(orgId, fileId);
  if (!src) return { fileId: null, reason: "no-source", region: null, frame: null };
  const cut = await cropBytes(src.buf, box, opts);
  if (!cut.ok) return { fileId: null, reason: cut.reason, region: cut.region, frame: cut.frame };
  const written = await platform().files.write(orgId, cut.bytes, {
    filename: `split-${fileId}.jpg`,
    mimeType: "image/jpeg",
  });
  if (!written?.fileId) return { fileId: null, reason: "write-failed", region: cut.region, frame: cut.frame };
  return { fileId: written.fileId, region: cut.region, frame: cut.frame };
}

/** The vision prompt for splitting a group photo. Boxes as 0–1 fractions of
 *  the image; one entry per DISTINCT physical item (not per duplicate unit —
 *  duplicates ride the qty field). */
export const SPLIT_PROMPT =
  "This photo shows MULTIPLE distinct physical items. List each distinct item " +
  "(group identical duplicates as ONE entry with a qty). For each: a concise " +
  "name (brand + what it is when legible), the brand if legible, how many " +
  "identical units are visible, and its bounding box as fractions of the " +
  "image (x,y = top-left corner, w,h = size, all 0..1).\n\n" +
  'Reply with ONLY a JSON object: {"items": [{"name": <string>, ' +
  '"brand": <string|null>, "qty": <int>=1>, ' +
  '"box": {"x": <0..1>, "y": <0..1>, "w": <0..1>, "h": <0..1>}}]}. ' +
  "If the photo really shows only ONE item, reply {\"items\": []}.";

export interface SplitItem {
  name: string;
  brand: string | null;
  qty: number;
  /** Where it sits in the group photo, so the child can be CROPPED to just it.
   *  Null when the item came from the observation pass instead of segmentation —
   *  we know WHAT it is but not where. The child then keeps the group shot and
   *  earns a proper product photo from the catalog image search, by name. */
  box: SplitBox | null;
  /** The scale the model answered in, for the record. */
  box_scale?: BoxScale;
}

export type BoxScale = "fraction" | "percent" | "per-mille" | "pixels";

/** A box as the model wrote it, brought to fractions of the displayed frame.
 *
 *  The prompt asks for 0..1 fractions and a model may answer in its own
 *  convention regardless: some report 0..1000 (a four-ball yarn photo came
 *  back as {x: 718, y: 48, w: 282, h: 910} and friends, four strips of a
 *  1000-wide frame), some in percent, some in pixels. Read as fractions,
 *  every one of those covered more than the whole frame and every crop was
 *  refused as too large (#2970). The scale is told from the numbers: all
 *  within 0..1 are fractions; within 0..100, percent; within 0..1000, per
 *  mille; beyond that, pixels of the frame. Null when no reading fits. */
export function normalizeSplitBox(
  raw: { x: number; y: number; w: number; h: number },
  frame: { width: number; height: number } | null,
): { box: SplitBox; scale: BoxScale } | null {
  const { x, y, w, h } = raw;
  if ([x, y, w, h].some((v) => !Number.isFinite(v) || v < 0) || w <= 0 || h <= 0) return null;
  const right = x + w;
  const bottom = y + h;
  const within = (n: number) => right <= n * 1.02 && bottom <= n * 1.02;
  if (within(1)) return { box: { x, y, w, h }, scale: "fraction" };
  if (within(100)) return { box: { x: x / 100, y: y / 100, w: w / 100, h: h / 100 }, scale: "percent" };
  if (within(1000)) return { box: { x: x / 1000, y: y / 1000, w: w / 1000, h: h / 1000 }, scale: "per-mille" };
  if (frame && frame.width > 0 && frame.height > 0 && right <= frame.width * 1.02 && bottom <= frame.height * 1.02) {
    return { box: { x: x / frame.width, y: y / frame.height, w: w / frame.width, h: h / frame.height }, scale: "pixels" };
  }
  return null;
}

/** Ask vision to segment the photo into distinct items. Returns [] when the
 *  model sees one item / can't parse — the caller 409s "nothing to split". */
export async function detectSplitItems(
  orgId: string,
  fileId: string,
  userId?: string | null,
): Promise<SplitItem[]> {
  const src = await readBytes(orgId, fileId);
  if (!src) return [];
  let raw: unknown;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "split-image",
      input: {
        image_b64: src.buf.toString("base64"),
        image_media_type: src.mime,
        prompt: SPLIT_PROMPT,
      },
      source: { kind: "core-scan:split", id: fileId },
      userId: userId ?? undefined,
      // The cache may now serve this. It couldn't before: the key didn't include
      // the prompt, so a split call and an IDENTIFY call on the same photo hashed
      // to the SAME key — a cache hit would have handed the split the identify's
      // answer. `bypass_cache: true` was the workaround for that collision (and
      // meant every split paid full price, for a call that couldn't work anyway).
      // The prompt fingerprint separates them properly, so N children splitting
      // the same parent image now share one call instead of firing N identical
      // ones.
    });
    const res = r.result as { text?: string; content?: string };
    const text = (res.text ?? res.content ?? "").trim();
    const jsonStr = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    raw = jsonStr ? JSON.parse(jsonStr) : null;
  } catch (err) {
    console.error("[core-scan] split detect failed:", (err as Error)?.message ?? err);
    return [];
  }
  const items = Array.isArray((raw as { items?: unknown })?.items)
    ? ((raw as { items: unknown[] }).items as Array<Record<string, unknown>>)
    : [];
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  // The displayed frame, for a model that answered in pixels.
  const up = await uprightBytes(src.buf);
  const frame = up?.meta.width && up.meta.height ? { width: up.meta.width, height: up.meta.height } : null;
  const out: SplitItem[] = [];
  for (const it of items) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const box = (it.box ?? {}) as Record<string, unknown>;
    const x = num(box.x), y = num(box.y), w = num(box.w), h = num(box.h);
    if (!name || [x, y, w, h].some(Number.isNaN)) continue;
    const read = normalizeSplitBox({ x, y, w, h }, frame);
    if (!read || read.box.w <= 0.01 || read.box.h <= 0.01) continue;
    out.push({
      name,
      brand: typeof it.brand === "string" && it.brand.trim() ? it.brand.trim() : null,
      qty: Math.max(1, Math.round(num(it.qty) || 1)),
      box: read.box,
      box_scale: read.scale,
    });
  }
  return out;
}

// ── the product photo inside a screenshot ────────────────────────────────────
// A screenshot of a marketplace listing already contains a good picture of the
// item, wrapped in app chrome, price, seller and buttons. Cropping that out
// beats searching the internet for a picture of some OTHER unit of the same
// product: it is the actual thing, and it needs no search, no fetch, and no
// chance of a hotlink-blocked 404 (a failure mode the web-image path carries
// real code for).
//
// The BOX comes back on the identify reply, which already looks at every photo,
// so finding it costs no extra call. An earlier draft made a second, gated call
// instead — and the gate could not be built: four deterministic tests for "is
// this a screenshot?" were measured against the committed fixtures and all four
// failed. See docs/design-decisions/screenshot-to-catalog.md for the numbers.
// What is left here is the part that still matters, which is refusing a box that
// would make the catalog image worse.

/** Validate a reply into a usable box, or null. Pure — exported for tests.
 *
 *  The size floor is the load-bearing part. A model that finds no photograph
 *  sometimes returns a sliver or a near-full-frame box instead of the null it
 *  was asked for, and both are worse than doing nothing: a sliver crops away the
 *  item, and a near-full-frame "crop" is the screenshot again, chrome and all,
 *  installed as the catalog image. */
export function parseProductRegion(raw: unknown): SplitBox | null {
  const box = (raw as { box?: unknown } | null)?.box;
  if (!box || typeof box !== "object") return null;
  const b = box as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const x = num(b.x), y = num(b.y), w = num(b.w), h = num(b.h);
  if ([x, y, w, h].some(Number.isNaN)) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  if (x + w > 1.001 || y + h > 1.001) return null;
  const area = w * h;
  // Too small to BE the product photo — a logo, an avatar, a thumbnail.
  if (area < 0.05) return null;
  // Effectively the whole screenshot, so cropping it achieves nothing except
  // installing the page chrome as the catalog image.
  if (area > 0.9) return null;
  return { x, y, w, h };
}
