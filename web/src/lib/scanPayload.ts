// What a scan payload IS, decided once for both doors.
//
// The camera classified a decoded value (a Cobblr label URL routes to the
// labelled place; a retail code goes to lookup; a marketing link is held for
// a barcode) and the typed field beside it did not: it posted whatever was
// typed as a barcode, so a pasted location label URL became a pending inbox
// item named "Cobblr" with the URL as its text (the 2026-09-13 review,
// #2850). Two doors, two rules, is how that happens. This is the one rule;
// the capability row scan:payload-classifier keeps the doors from growing
// their own again.
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";

export type ScanPayload =
  /** A printed Cobblr label: a navigation or a filing target, never a product. */
  | { kind: "cobblr-qr"; token: string }
  /** A retail digit code (UPC / EAN / ISBN-13): the lookup. */
  | { kind: "product-code"; code: string }
  /** Any other symbol a label can carry: a SKU, a serial, a Code-128 fragment. */
  | { kind: "code"; code: string }
  /** A generic web link (a product's marketing QR). */
  | { kind: "link"; url: string }
  /** Words, not a code. Only the typed door can produce this. */
  | { kind: "words"; text: string }
  | { kind: "empty" };

/** Digits only, the retail lengths (EAN-8 to GTIN-14; an ISBN-13 is an EAN). */
const PRODUCT_CODE = /^\d{8,14}$/;
/** A symbol: one token, no spaces, the characters a barcode symbology can
 *  carry. Words are refused by the second test: a code has a digit in it or
 *  is written in capitals ("WX-00042", "SKU-A7"); "hello" is neither. */
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._\-\/:+#]{2,79}$/;

export function classifyScanPayload(raw: string): ScanPayload {
  const v = raw.trim();
  if (!v) return { kind: "empty" };
  const token = qrTokenFromUrl(v);
  if (token) return { kind: "cobblr-qr", token };
  if (/^https?:\/\//i.test(v)) return { kind: "link", url: v };
  if (PRODUCT_CODE.test(v)) return { kind: "product-code", code: v };
  if (SYMBOL.test(v) && (/\d/.test(v) || v === v.toUpperCase())) return { kind: "code", code: v };
  return { kind: "words", text: v };
}

/** What the TYPED door does with a payload. The camera decodes what it sees
 *  and may hold a link for a barcode; a person typing a link or a sentence
 *  has not typed a code, and filing it makes an inbox item nobody wanted. */
export type TypedVerdict =
  | { action: "route-qr"; token: string }
  | { action: "lookup"; code: string }
  | { action: "refuse"; sentence: string }
  | { action: "nothing" };

/** What the field takes, as its label; the placeholder is the short form,
 *  since 41 characters clip mid-word at phone width in the mono face. */
export const TYPED_FIELD_HINT = "Barcode number, or paste a Cobblr QR link";
export const TYPED_FIELD_PLACEHOLDER = "Barcode, or a Cobblr QR link";

export function typedVerdict(raw: string): TypedVerdict {
  const p = classifyScanPayload(raw);
  switch (p.kind) {
    case "cobblr-qr":
      return { action: "route-qr", token: p.token };
    case "product-code":
    case "code":
      return { action: "lookup", code: p.code };
    case "link":
      return { action: "refuse", sentence: "That is a web link, not a code. Type a barcode number, or paste a Cobblr QR link." };
    case "words":
      return { action: "refuse", sentence: "That is not a barcode. Type the number under the bars, or paste a Cobblr QR link." };
    case "empty":
      return { action: "nothing" };
  }
}
