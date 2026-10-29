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
import { withArticle } from "@cobblr/platform-contract/plural";
import { productName } from "@cobblr/platform-web";
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";
import { isOwnCobblrLink, ownAppPath } from "@cobblr/platform-contract/own-hosts";
import type { OwnRoute } from "./openOwnRoute";

export type ScanPayload =
  /** A printed Cobblr label: a navigation or a filing target, never a product. */
  | { kind: "cobblr-qr"; token: string }
  /** A retail digit code (UPC / EAN / ISBN-13): the lookup. */
  | { kind: "product-code"; code: string }
  /** Any other symbol a label can carry: a SKU, a serial, a Code-128 fragment. */
  | { kind: "code"; code: string }
  /** A generic web link (a product's marketing QR). */
  | { kind: "link"; url: string }
  /** A link to Cobblr itself (the platform's site or sandbox, or this
   *  instance), not a label: a booth's own display QR behind the item. The
   *  scanner ignores it and keeps scanning (own-hosts.ts). */
  | { kind: "own-link"; url: string }
  /** A link to a page of the instance the scanner runs on: a record, the
   *  open door, a pairing or invite link. Opens that page (own-hosts.ts). */
  | { kind: "own-route"; route: OwnRoute }
  /** Words, not a code. Only the typed door can produce this. */
  | { kind: "words"; text: string }
  | { kind: "empty" };

/** Digits only, the retail lengths (EAN-8 to GTIN-14; an ISBN-13 is an EAN). */
const PRODUCT_CODE = /^\d{8,14}$/;
/** A symbol: one token, no spaces, the characters a barcode symbology can
 *  carry. Words are refused by the second test: a code has a digit in it or
 *  is written in capitals ("WX-00042", "SKU-A7"); "hello" is neither. */
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._\-\/:+#]{2,79}$/;

/** The instance the page runs on is "own" as well: a self-hosted workspace's
 *  own address on its own display. */
function pageOrigins(): string[] {
  return typeof window !== "undefined" && window.location?.origin ? [window.location.origin] : [];
}

export function classifyScanPayload(raw: string, ownOrigins: readonly string[] = pageOrigins()): ScanPayload {
  const v = raw.trim();
  if (!v) return { kind: "empty" };
  const token = qrTokenFromUrl(v);
  if (token) return { kind: "cobblr-qr", token };
  const path = ownAppPath(v, ownOrigins);
  if (path) return { kind: "own-route", route: { href: path } };
  if (isOwnCobblrLink(v, ownOrigins)) return { kind: "own-link", url: v };
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
  | { action: "open"; route: OwnRoute }
  | { action: "lookup"; code: string }
  | { action: "refuse"; sentence: string }
  | { action: "nothing" };

/** What the field takes, as its label; the placeholder is the short form,
 *  since 41 characters clip mid-word at phone width in the mono face. */
export const TYPED_FIELD_HINT = `Barcode number, or paste ${withArticle(productName())} QR link`;
export const TYPED_FIELD_PLACEHOLDER = `Barcode, or ${withArticle(productName())} QR link`;

export function typedVerdict(raw: string, ownOrigins?: readonly string[]): TypedVerdict {
  const p = classifyScanPayload(raw, ownOrigins);
  switch (p.kind) {
    case "cobblr-qr":
      return { action: "route-qr", token: p.token };
    case "own-route":
      return { action: "open", route: p.route };
    case "product-code":
    case "code":
      return { action: "lookup", code: p.code };
    case "link":
    case "own-link":
      return { action: "refuse", sentence: `That is a web link, not a code. Type a barcode number, or paste ${withArticle(productName())} QR link.` };
    case "words":
      return { action: "refuse", sentence: `That is not a barcode. Type the number under the bars, or paste ${withArticle(productName())} QR link.` };
    case "empty":
      return { action: "nothing" };
  }
}

/** Codes the camera never acts on: a link to Cobblr itself. Filtered before a
 *  frame's codes are ranked, so the display QR behind an item can neither be
 *  filed nor crowd out the item's barcode read in the same frame. */
export function scannerIgnores(raw: string, ownOrigins?: readonly string[]): boolean {
  return classifyScanPayload(raw, ownOrigins).kind === "own-link";
}

/** What a hardware scanner (a keyboard wedge) does with a payload, outside the
 *  Scan page. The same rule the lens reads: a Cobblr label jumps to its place,
 *  a link to a page here (an action label, a record) opens it, a link to
 *  Cobblr itself is ignored, a retail code is staged, and anything else asks
 *  the resolvers (a declared identifier, a spool's URL). */
export type WedgeVerdict =
  | { action: "route-qr"; token: string }
  | { action: "open"; route: OwnRoute }
  | { action: "ignore" }
  | { action: "stage"; code: string }
  | { action: "resolve"; code: string };

export function wedgeVerdict(raw: string, ownOrigins?: readonly string[]): WedgeVerdict {
  const p = classifyScanPayload(raw, ownOrigins);
  switch (p.kind) {
    case "cobblr-qr":
      return { action: "route-qr", token: p.token };
    case "own-route":
      return { action: "open", route: p.route };
    case "own-link":
    case "empty":
      return { action: "ignore" };
    case "product-code":
      return { action: "stage", code: p.code };
    case "code":
      return { action: "resolve", code: p.code };
    case "link":
      return { action: "resolve", code: p.url };
    case "words":
      return { action: "resolve", code: p.text };
  }
}
