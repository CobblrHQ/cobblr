// VOCAB-ENUMERATION OK: this is the EXTRACTOR, and naming the concepts is its
// entire job. It turns receipt-shaped metadata into role-tagged facts, which is
// the one place that must know a vendor is a "where I got it" and a net price
// is a "what it cost". Everything downstream of it is generic and must stay so:
// the matcher never learns any of these names.
//
// It lives in its own file rather than inside the confirm route so that
// knowledge is small, named, and visible. Buried in a 5500-line route handler
// it reads as incidental; here it reads as the boundary it is.
//
// See docs/design-decisions/arrivals.md.

import type { RoledFacts } from "@cobblr/platform-contract";

/** The receipt keys `materializeReceiptLines` stamps on an inbox item. */
export interface ReceiptMeta {
  receipt_vendor?: unknown;
  receipt_seller?: unknown;
  receipt_date?: unknown;
  net_price?: unknown;
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * What this purchase WAS, keyed by meaning.
 *
 * Only facts we actually established: an absent key is absent, never a guess.
 * The caller hands the result to the generic matcher, which decides where each
 * one lands based on what the workspace declared.
 */
export function receiptFacts(meta: ReceiptMeta | null | undefined): RoledFacts {
  const facts: RoledFacts = {};
  if (!meta) return facts;

  const vendor = str(meta.receipt_vendor);
  const seller = str(meta.receipt_seller);

  // Where you got it: the shop, or the person when there is no shop. A
  // marketplace has both, and the marketplace is the durable, groupable answer.
  const from = vendor ?? seller;
  if (from) facts["acquired-from"] = from;

  // WHO sold it, only when it is a second fact. Echoing the vendor back would
  // make a clarifier that reads "eBay · eBay".
  if (seller && seller !== vendor) facts.seller = seller;

  const date = str(meta.receipt_date);
  if (date) facts["acquired-on"] = date;

  // net_price ONLY. It is null unless the receipt's own numbers reconciled, so
  // a price we could not corroborate never reaches a field. The list price and
  // the card charge are both real numbers and neither answers "what did this
  // cost me", which is what the role means.
  if (typeof meta.net_price === "number" && Number.isFinite(meta.net_price)) {
    facts["acquired-for"] = meta.net_price;
  }

  return facts;
}
