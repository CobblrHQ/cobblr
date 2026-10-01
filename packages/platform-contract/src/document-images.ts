// The pictures a document carries: the one door for reading the embedded
// raster images out of a PDF.
//
// Two features need them and must not each carry a PDF decoder: a pattern's
// finished-object photo (projects), and a scanned receipt or bill of sale,
// which is a PDF around one photo of the paper and has no text to read
// (core-scan, #4523). The file store (core-files) registers the reader at
// boot, so neither module imports the other or the decoder.
//
// Buildless subpath: no imports, so a module can depend on it freely.

export interface ExtractedImage {
  /** PNG-encoded bytes. */
  png: Buffer;
  width: number;
  height: number;
  /** width × height, the ranking key: the largest is the page's photo. */
  area: number;
  /** PNG byte length. */
  bytes: number;
  /** Which page it came from (1-based). */
  page: number;
}

export interface DocumentImageOptions {
  /** Drop images whose shorter side is below this (px). */
  minSide?: number;
  /** Drop images whose PNG is smaller than this (bytes). */
  minBytes?: number;
  /** Stop after this many pages. Default: every page. */
  maxPages?: number;
}

export type DocumentImageReader = (pdfBytes: Uint8Array, opts?: DocumentImageOptions) => Promise<ExtractedImage[]>;

let reader: DocumentImageReader | null = null;

/** The file store registers its reader once at boot. */
export function registerDocumentImageReader(r: DocumentImageReader): void {
  reader = r;
}

/** The PDF's embedded images, largest first. `[]` when it has none or cannot
 *  be read; null when no reader is registered (the file store is not
 *  loaded), which a caller must not mistake for "no pictures in it". */
export async function documentImages(pdfBytes: Uint8Array, opts?: DocumentImageOptions): Promise<ExtractedImage[] | null> {
  if (!reader) return null;
  return reader(pdfBytes, opts);
}
