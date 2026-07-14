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

/** Crop one region (fraction box, 5% padding, clamped) → a NEW file id. */
export async function cropRegion(orgId: string, fileId: string, box: SplitBox): Promise<string | null> {
  const src = await readBytes(orgId, fileId);
  if (!src) return null;
  const img = sharp(src.buf, { failOn: "none" });
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const pad = 0.05;
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
