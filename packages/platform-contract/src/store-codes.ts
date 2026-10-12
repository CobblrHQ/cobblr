// A shop's own barcode (GS1 restricted circulation): the one rule, read by the
// scan's classifier, its lookups, its caches, the review card and the heal.
//
// A number in these ranges is printed by a shop for its own use: a deli or
// produce label with the weight or price inside it, a loyalty stub, an
// in-store SKU. Every shop reuses the same numbers, so the code means
// something only inside the shop that printed it, and a global catalog's
// answer for it is some OTHER shop's product. 20446079 on a jar of ground
// cumin came back from a global lookup as a J. Jill wool skirt, and the
// skirt replaced the cumin's name (#6100).
//
// The ranges:
//  - EAN-13 (and a GTIN-14 with its packaging indicator dropped): 20 to 29,
//    and 02 / 04, which are the same codes as a 12-digit UPC-A starting 2 or 4.
//  - EAN-8: starting 2 (RCN-8), always; starting 0 only when the eight digits
//    are not a valid UPC-E, because a UPC-E (the short code on a US can of
//    soda) also has eight digits starting 0, and is a real product code.
// The check digit is still required: a mis-read of a real product's code is a
// mis-read, not a shop's code.
import { gtinChecksumOk } from "@cobblr/platform-contract/identifier-check";

/** A UPC-E's twelve-digit UPC-A, or null when the eight digits are not one
 *  (number system 0 or 1, six data digits, a check digit). */
export function upcEToUpcA(code: string): string | null {
  const c = code.trim();
  if (!/^[01]\d{7}$/.test(c)) return null;
  const ns = c[0]!;
  const d = c.slice(1, 7);
  const last = Number(d[5]);
  const body =
    last <= 2 ? `${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}` : last === 3 ? `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}` : last === 4 ? `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}` : `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}`;
  return `${ns}${body}${c[7]}`;
}

/** Is this eight-digit code a valid UPC-E (its expansion checks)? */
export function isValidUpcE(code: string): boolean {
  const a = upcEToUpcA(code);
  return !!a && gtinChecksumOk(a);
}

/** Which kind of shop's own code this is, by its digits alone, or null for
 *  any other code. "variable-measure" is a weighed or priced label (UPC-A 2…,
 *  EAN-13 02 / 20 to 29 in most countries' use); "in-store" is a shop's own
 *  item number (UPC-A 4…, EAN-13 04); "ean-8" is a shop's short code. The
 *  check digit is NOT judged here (see isStoreCode), except for a 0… EAN-8,
 *  whose prefix alone decides nothing. */
export function storeCodeKind(code: string): "ean-8" | "variable-measure" | "in-store" | null {
  const c = code.trim();
  if (/^\d{8}$/.test(c)) {
    if (c[0] === "2") return "ean-8";
    // A 0… code is a shop's own only when it reads as one and as nothing
    // else: an EAN-8 check digit that holds, and not a UPC-E. Its prefix
    // alone says nothing, so a 0… code that checks as neither stays what it
    // always was, a product code a lookup judges.
    if (c[0] === "0" && gtinChecksumOk(c) && !isValidUpcE(c)) return "ean-8";
    return null;
  }
  if (!/^\d{12,14}$/.test(c)) return null;
  const gtin13 = c.length === 12 ? `0${c}` : c.length === 14 ? c.slice(1) : c;
  if (/^04/.test(gtin13)) return "in-store";
  if (/^(02|2\d)/.test(gtin13)) return "variable-measure";
  return null;
}

/** In a shop's own range, whatever its check digit says. */
export function hasStoreCodePrefix(code: string): boolean {
  return storeCodeKind(code) !== null;
}

/** A shop's own code: in the range, with a valid check digit. Never looked up
 *  in a global catalog, never cached for other workspaces. */
export function isStoreCode(code: string): boolean {
  return hasStoreCodePrefix(code) && gtinChecksumOk(code.trim());
}
