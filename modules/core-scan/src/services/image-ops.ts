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
  /** 0–1 fractions of the source image. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Crop one region (fraction box, clamped) → a NEW file id.
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
export async function cropRegion(
  orgId: string,
  fileId: string,
  box: SplitBox,
  opts: { pad?: number } = {},
): Promise<string | null> {
  const src = await readBytes(orgId, fileId);
  if (!src) return null;
  const img = sharp(src.buf, { failOn: "none" });
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const pad = opts.pad ?? 0.05;
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp01(box.x - pad * box.w);
  const y0 = clamp01(box.y - pad * box.h);
  const x1 = clamp01(box.x + box.w * (1 + pad));
  const y1 = clamp01(box.y + box.h * (1 + pad));
  const left = Math.round(x0 * W);
  const top = Math.round(y0 * H);
  const width = Math.max(16, Math.round((x1 - x0) * W));
  const height = Math.max(16, Math.round((y1 - y0) * H));
  const out = await img
    .extract({
      left: Math.min(left, W - 16),
      top: Math.min(top, H - 16),
      width: Math.min(width, W - Math.min(left, W - 16)),
      height: Math.min(height, H - Math.min(top, H - 16)),
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  const written = await platform().files.write(orgId, out, {
    filename: `split-${fileId}.jpg`,
    mimeType: "image/jpeg",
  });
  return written?.fileId ?? null;
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
      capability: "identify-image",
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
  const out: SplitItem[] = [];
  for (const it of items) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const box = (it.box ?? {}) as Record<string, unknown>;
    const x = num(box.x), y = num(box.y), w = num(box.w), h = num(box.h);
    if (!name || [x, y, w, h].some(Number.isNaN) || w <= 0.01 || h <= 0.01) continue;
    out.push({
      name,
      brand: typeof it.brand === "string" && it.brand.trim() ? it.brand.trim() : null,
      qty: Math.max(1, Math.round(num(it.qty) || 1)),
      box: { x, y, w, h },
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
