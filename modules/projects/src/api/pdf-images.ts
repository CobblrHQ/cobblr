// A pattern PDF's pictures, read through the platform's document-image reader.
//
// The decoder itself lives with the file store (core-files registers it on
// @cobblr/platform-contract/document-images), so a scanned receipt and a
// pattern photo are read by one implementation. What stays here is the
// pattern policy: how far into a pattern the photo hunt reads.

import { documentImages, type DocumentImageOptions, type ExtractedImage } from "@cobblr/platform-contract/document-images";

export type { ExtractedImage } from "@cobblr/platform-contract/document-images";

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

/** The platform's reader; none registered (the file store is not loaded)
 *  reads as no pictures, which for a pattern photo is the same answer. */
async function extractPdfImages(pdfBytes: Uint8Array, opts: DocumentImageOptions): Promise<ExtractedImage[]> {
  return (await documentImages(pdfBytes, opts)) ?? [];
}

/** The ONE way to read images out of a pattern PDF.
 *
 *  Use this, not the reader directly - the measured score only describes the
 *  product while both read the same range. */
export function extractPatternImages(pdfBytes: Uint8Array): Promise<ExtractedImage[]> {
  return extractPdfImages(pdfBytes, { maxPages: PATTERN_PDF_PAGE_LIMIT });
}
