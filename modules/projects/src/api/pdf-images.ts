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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

/** How far into a pattern PDF the photo hunt reads.
 *
 *  A finished-object photo sits at the FRONT of a pattern. Past that a document
 *  is body matter, and on a long datasheet the later pages are wiring diagrams,
 *  pinout charts and package drawings that the floor was never measured against.
 *  Reading everything is also slow: every page gets decoded.
 *
 *  This is a policy, and it has to be ONE number. It was two: the scoreboard
 *  scored the floor 26/26 reading 12 pages while the product read every page and
 *  scored 21/26, because each call site picked for itself and nothing made them
 *  agree. Same corpus, same picker, same labels - only the page range differed,
 *  and maker-guides fell from 5/5 to 2/5.
 *
 *  So every caller goes through extractPatternImages(), and
 *  scripts/lint-pattern-photo-one-extractor.ts keeps it that way. */
export const PATTERN_PDF_PAGE_LIMIT = 12;

/** The ONE way to read images out of a pattern PDF.
 *
 *  Use this, not extractPdfImages directly - the measured score only describes
 *  the product while both read the same range. */
export function extractPatternImages(pdfBytes: Uint8Array): Promise<ExtractedImage[]> {
  return extractPdfImages(pdfBytes, { maxPages: PATTERN_PDF_PAGE_LIMIT });
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
      // WITHOUT THIS, JPEG 2000 IMAGES DECODE TO NULL — silently. pdfjs decodes
      // JPX (and ICC colour management for JPEGs) through wasm modules it
      // ships in its own package, and in Node it only finds them when told
      // where they are. Measured on the corpus: three of nine knitting
      // patterns from one mainstream publisher (InDesign exports, JPXDecode
      // throughout) yielded ZERO images and the UI said "no photo found";
      // with this line they yield every photo. The failure mode is exactly the
      // one this whole feature exists to avoid: a button that looks like it
      // worked and attached nothing.
      wasmUrl: pdfjsWasmDir(),
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
        obj = await resolveObj(page, arg0);
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

/** pdfjs-dist ships its decoders (openjpeg, qcms) as wasm beside the build.
 *  Resolved from the package rather than a hardcoded path so a hoisted or
 *  nested install both work; a file: URL with a trailing slash is what pdfjs
 *  joins the module names onto. */
function pdfjsWasmDir(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("pdfjs-dist/package.json");
  return pathToFileURL(join(dirname(pkg), "wasm") + "/").href;
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
  /** Callback form: invoked once the object has decoded, or immediately when
   *  it already has. The zero-arg form returns only what is ready now. */
  get(name: string, onReady?: (obj: PdfImageObj | null | undefined) => void): PdfImageObj | undefined;
}
type SharpFactory = (
  input: Buffer,
  opts: { raw: { width: number; height: number; channels: 1 | 3 | 4 } },
) => { png(): { toBuffer(): Promise<Buffer> } };

/** How long to wait for a decoder before treating an image as absent. JPX
 *  through wasm on a page-one hero is tens of milliseconds; a whole second is
 *  generous, and past it something is wrong with the file, not the clock. */
const RESOLVE_TIMEOUT_MS = 1_000;

/**
 * Resolve a painted image by name, WAITING for it to decode.
 *
 * The synchronous `objs.get(name)` returns what is decoded RIGHT NOW, and the
 * `has(name)` guard before it reads false for anything still in flight. With
 * pure-JS JPEG decoding everything is ready by the time getOperatorList
 * resolves, so the sync form looked correct; JPEG 2000 decodes through wasm on
 * its own schedule, so every JPX image read as "not present" and the extractor
 * returned nothing for a PDF full of photos. The callback form is pdfjs's
 * own "tell me when it is ready", and a timeout keeps a broken object from
 * holding the request open.
 */
function resolveObj(page: PdfPage, name: string): Promise<PdfImageObj | undefined> {
  // pdfjs keeps globally shared resources (fonts, and images reused across
  // pages) under a `g_` prefix in commonObjs; everything else is per page.
  const store = name.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), RESOLVE_TIMEOUT_MS);
    try {
      store.get(name, (obj: PdfImageObj | null | undefined) => {
        clearTimeout(timer);
        resolve(obj ?? undefined);
      });
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}
