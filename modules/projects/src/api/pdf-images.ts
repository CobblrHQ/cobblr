// Pull the embedded raster images out of a PDF.
//
// A pattern PDF (and manuals, spec sheets, catalogs) usually carries the
// finished-object photo embedded on page one. `pdf-parse` gives us the TEXT;
// this gives us the PICTURES. We walk each page's operator list, pick out the
// image-paint ops (`paintImageXObject` / the legacy `paintJpegXObject` /
// inline images), resolve the decoded raster from the page's object store, and
// re-encode each to PNG with sharp — mapping pdfjs's ImageKind to sharp's raw
// channel count (GRAYSCALE_1BPP→1, RGB_24BPP→3, RGBA_32BPP→4).
//
// Decorative bits (rules, icons, 1-bit bitmaps) are filtered out by a minimum
// side / minimum byte-size gate; exact repeats are de-duped by a hash of the
// raw pixels; and the result is ranked largest-first so the hero photo (the
// biggest image) sorts to the front.
//
// pdfjs-dist and sharp are resolved dynamically (same pattern as the
// pdf-parse import next door) — they're hoisted at the repo root, not a hard
// dependency of the projects bundle's static graph.

import { createHash } from "node:crypto";

export interface ExtractedImage {
  /** PNG-encoded bytes, ready to hand to core-files. */
  png: Buffer;
  width: number;
  height: number;
  /** width × height — the ranking key (largest = the hero photo). */
  area: number;
  /** PNG byte length. */
  bytes: number;
  /** Which PDF page it came from (1-based). */
  page: number;
}

export interface ExtractPdfImagesOptions {
  /** Drop images whose shorter side is below this (px). Default 64 — kills
   *  rules, bullets, hairlines and icons while keeping real photos. */
  minSide?: number;
  /** Drop images whose PNG is smaller than this (bytes). Default 3 KB. */
  minBytes?: number;
  /** Stop after this many pages (a hero photo is almost always on page 1–2;
   *  bounds the work on a 100-page catalog). Default: all pages. */
  maxPages?: number;
}

// pdfjs ImageKind → raw channel count for sharp.
const KIND_CHANNELS: Record<number, 1 | 3 | 4> = {
  1: 1, // GRAYSCALE_1BPP
  2: 3, // RGB_24BPP
  3: 4, // RGBA_32BPP
};

interface PdfImageObj {
  width: number;
  height: number;
  kind: number;
  data?: Uint8Array | Uint8ClampedArray;
}

/**
 * Extract the embedded raster images from a PDF as PNGs, filtered and ranked
 * largest-first. Returns `[]` (never throws) when the PDF has no usable
 * images or can't be parsed.
 */
export async function extractPdfImages(
  pdfBytes: Uint8Array,
  opts: ExtractPdfImagesOptions = {},
): Promise<ExtractedImage[]> {
  const minSide = opts.minSide ?? 64;
  const minBytes = opts.minBytes ?? 3_072;

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDocument> };
    OPS: Record<string, number>;
  };
  const sharpMod = (await import("sharp")) as unknown as { default: SharpFactory };
  const sharp = sharpMod.default;
  const OPS = pdfjs.OPS;

  const imageOps = new Set<number>(
    [OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject].filter(
      (v): v is number => typeof v === "number",
    ),
  );

  // pdfjs mutates the buffer it's handed; give it a private copy so a caller's
  // bytes (e.g. one we also feed to pdf-parse) aren't disturbed.
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true,
      isEvalSupported: false,
      // We only walk operator lists for images — never render text — so the
      // missing standard-font data is irrelevant. verbosity:0 mutes pdfjs's
      // font/eval warnings so they don't spam the api logs.
      verbosity: 0,
    })
    .promise;

  const pageCount = opts.maxPages ? Math.min(opts.maxPages, doc.numPages) : doc.numPages;
  const seen = new Set<string>(); // raw-pixel hashes, for de-dupe
  const out: ExtractedImage[] = [];

  for (let p = 1; p <= pageCount; p++) {
    let page: PdfPage;
    try {
      page = await doc.getPage(p);
    } catch {
      continue;
    }
    let ops: { fnArray: number[]; argsArray: unknown[][] };
    try {
      ops = await page.getOperatorList();
    } catch {
      continue;
    }

    for (let i = 0; i < ops.fnArray.length; i++) {
      if (!imageOps.has(ops.fnArray[i]!)) continue;
      const arg0 = ops.argsArray[i]?.[0];

      // paintImageXObject / paintJpegXObject pass an object NAME to resolve
      // from the page store; inline images pass the decoded object directly.
      let obj: PdfImageObj | undefined;
      if (typeof arg0 === "string") {
        obj = resolveObj(page, arg0);
      } else if (arg0 && typeof arg0 === "object") {
        obj = arg0 as PdfImageObj;
      }
      if (!obj || !obj.data || !obj.width || !obj.height) continue;

      const channels = KIND_CHANNELS[obj.kind];
      if (!channels) continue; // unknown pixel format — skip rather than guess
      if (Math.min(obj.width, obj.height) < minSide) continue;

      // Guard the raw→sharp contract: the decoded buffer must be exactly
      // width×height×channels. 1-bit bitmaps and other packed formats won't
      // match — dropping them also happens to drop decorative line art.
      const expected = obj.width * obj.height * channels;
      if (obj.data.length !== expected) continue;

      const hash = createHash("sha256").update(obj.data).digest("hex");
      if (seen.has(hash)) continue;
      seen.add(hash);

      let png: Buffer;
      try {
        const raw = Buffer.from(obj.data.buffer, obj.data.byteOffset, obj.data.length);
        png = await sharp(raw, { raw: { width: obj.width, height: obj.height, channels } })
          .png()
          .toBuffer();
      } catch {
        continue;
      }
      if (png.length < minBytes) continue;

      out.push({
        png,
        width: obj.width,
        height: obj.height,
        area: obj.width * obj.height,
        bytes: png.length,
        page: p,
      });
    }
  }

  await doc.destroy?.();
  out.sort((a, b) => b.area - a.area);
  return out;
}

// ── minimal structural types for the dynamically-imported deps ──────────────

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy?(): Promise<void>;
}
interface PdfPage {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: PdfObjs;
  commonObjs: PdfObjs;
}
interface PdfObjs {
  has(name: string): boolean;
  get(name: string): PdfImageObj | undefined;
}
type SharpFactory = (
  input: Buffer,
  opts: { raw: { width: number; height: number; channels: 1 | 3 | 4 } },
) => { png(): { toBuffer(): Promise<Buffer> } };

function resolveObj(page: PdfPage, name: string): PdfImageObj | undefined {
  // After getOperatorList resolves, the raster lives in the page store
  // (occasionally the shared common store). `.get` throws if not yet ready;
  // both are already populated at this point, so guard with `.has`.
  try {
    if (page.objs.has(name)) return page.objs.get(name);
  } catch {
    /* fall through */
  }
  try {
    if (page.commonObjs.has(name)) return page.commonObjs.get(name);
  } catch {
    /* fall through */
  }
  return undefined;
}
