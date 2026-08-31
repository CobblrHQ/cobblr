// WHERE a code on an inbox item came from, and what that means for trust.
//
// Three sources, and the difference between them is whether a machine READ the
// digits (and could be a digit off) or a scanner DECODED them:
//
//   scan     - decoded from the symbol itself, by hardware or the camera. The
//              absence of a `barcode_source` key means this: it is the original
//              case and the overwhelmingly common one.
//   ai-photo - OCR'd off a picture of the thing. Right digits, usually.
//   receipt  - read off a receipt document (an email, a PDF, a CSV, or a photo
//              of one). Same trust as ai-photo; different sentence to a person,
//              which is the whole reason it is its own value.
//   user     - typed in by a person, who is the authority on it.
//
// This file exists because the question "was this READ rather than scanned?"
// was spelled `=== "ai-photo"` in five places. Stamping a receipt code as
// "receipt" without this would have made all five treat it as a hardware scan -
// including the two that push a trusted code onto the entity's own
// metadata.barcode - so an eBay item number off a receipt would have been
// recorded as the product's barcode. One predicate, one vocabulary.

export type BarcodeSource = "ai-photo" | "receipt" | "user";

/** Every value that may be stamped. Asserted against the writers by a test. */
export const BARCODE_SOURCES: readonly BarcodeSource[] = ["ai-photo", "receipt", "user"] as const;

/**
 * Was this code READ by a machine rather than decoded from the symbol?
 *
 * True for a code OCR'd off a photo or lifted off a receipt: right digits
 * usually, and not to be trusted as the product's barcode without corroboration.
 * False for a scan (no source stamped) and for a code a person typed.
 */
export function isMachineReadCode(source: string | null | undefined): boolean {
  return source === "ai-photo" || source === "receipt";
}

/** How to SAY where it came from, to a person. Absent when there is nothing
 *  worth saying (a scan is the default and needs no note). */
export function barcodeSourceNote(source: string | null | undefined): string | null {
  if (source === "ai-photo") return "read from photo";
  // Not "photo": the receipt is usually an email or a PDF, and calling that a
  // photo is simply wrong - "what read from photo? I sent an ebay receipt
  // email" (the operator, 2026-08-31).
  if (source === "receipt") return "read from the receipt";
  return null;
}
