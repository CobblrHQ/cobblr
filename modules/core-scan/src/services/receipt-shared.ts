// Shared receipt types + coercion helpers — used by both the deterministic
// parsers (receipt-deterministic.ts) and the AI shaper (receipt.ts). Kept in
// its own module so neither imports the other (no cycle).

export interface ReceiptLine {
  description: string;
  qty: number;
  unit_price: number | null;
  /** What the line was rung up at, BEFORE any coupon printed under it. */
  line_total: number | null;
  /** The product number printed on the line (a UPC/EAN/PLU), digits only, or
   *  null. A till prints it beside the description and it is the most useful
   *  thing there: it resolves to a real catalog name and picture, where the
   *  till's own abbreviation ("16IN CHEESE") resolves to a guess.
   *
   *  OCR'd, so it carries the same lower trust a code read off a photo does —
   *  the row stamps it as AI-read rather than pretending it was scanned. */
  code: string | null;
  /** Money taken off this line by a coupon or discount printed beneath it, as a
   *  POSITIVE number. Null when there was none.
   *
   *  Kept apart from `line_total` rather than folded into it because the two are
   *  different facts and a purchase record wants both: the croissants were rung
   *  up at 0.98 and cost nothing. Folding would also make "what did this
   *  normally cost" unrecoverable, which is the number worth knowing next time.
   *
   *  A discount is never its own line. Nobody owns a coupon, and an inbox row
   *  called "Lidl Points Coupon" is not a thing to put on a shelf. */
  discount: number | null;
}

/** What a line actually cost: rung-up price less anything taken off it. */
export function lineNet(l: ReceiptLine): number {
  return (l.line_total ?? 0) - (l.discount ?? 0);
}

/** Title for the inbox session a parsed receipt becomes: the vendor when known
 *  ("Receipt · Home Depot"), else a plain "Receipt", plus the order/invoice number
 *  when stated ("Receipt · KC Tool #384602") so two receipts from one vendor are
 *  distinct. The inbox adds the time (and "emailed") as the subtitle. */
export function receiptSessionLabel(vendor: string | null | undefined, orderRef?: string | null): string {
  const v = (vendor ?? "").trim();
  const base = v ? `Receipt · ${v}` : "Receipt";
  const ref = cleanOrderRef(orderRef ?? null);
  return ref ? `${base} #${ref}` : base;
}

/** Inverse of receiptSessionLabel — recover the vendor from an existing session
 *  label. Used when editing the order # of a session created before vendor got its
 *  own column, so we can recompute the label. Null for a plain "Receipt". */
export function vendorFromLabel(label: string | null | undefined): string | null {
  const m = (label ?? "").match(/^Receipt · (.+?)(?:\s+#\S+)?$/);
  return m?.[1]?.trim() || null;
}

import {
  detectSeller,
  parseEstimatedDelivery,
  parseReceiptTotals,
  type ReceiptTotals,
} from "@cobblr/platform-contract/receipt-totals";

export interface ParsedReceipt {
  vendor: string | null;
  /** Order / invoice / reference number, when the receipt states one — makes two
   *  receipts from the same vendor distinct (bare identifier, no "Order" word). */
  order_ref: string | null;
  /** ISO YYYY-MM-DD when the receipt's date is parseable, else null. */
  date: string | null;
  /** ISO-4217 code, uppercased, when stated. */
  currency: string | null;
  total: number | null;
  /** WHO sold it, when that differs from the vendor. A marketplace listing
   *  carries both and they are not the same fact: the vendor is where you shop
   *  again, the seller may never come up twice. */
  seller: string | null;
  /** The money broken into components, with a reconciliation verdict. Null when
   *  there was no source text to read (a vision-only parse). See
   *  docs/design-decisions/arrivals.md for why the net price is the useful one
   *  and why an unreconciled one is withheld rather than guessed. */
  totals: ReceiptTotals | null;
  /** ISO date the receipt says it should arrive. This is what turns a receipt
   *  into an ORDER with an ETA rather than a thing you supposedly already own. */
  expected_arrival: string | null;
  /** What the parsed lines add up to, each NET of its own discount — the number
   *  that should equal what was charged. */
  lines_total: number;
  /** Do those lines add up to the total that was actually charged? Null when
   *  the receipt states no total to check against.
   *
   *  A DIFFERENT question from `totals.reconciled`, which asks whether the money
   *  components (net + tax + shipping) land on the amount charged. This one asks
   *  whether the ITEMS do, and a receipt can fail either alone. The case that
   *  found it: a supermarket receipt with two per-item coupon lines. The prompt
   *  tells the model to skip discount rows, correctly, so the items come back at
   *  their pre-coupon prices and sum to 5.72 against a printed 4.74. Every field
   *  is individually right and the set of them is wrong, and until this flag
   *  existed the only tier that would have noticed was the text one. */
  lines_reconcile: boolean | null;
  items: ReceiptLine[];
}

/** How a receipt was read — surfaced on the result + stamped into each inbox
 *  row's metadata so triage (and debugging) knows whether a line came from a
 *  deterministic parse or the AI fallback. */
export type ParseMethod = "csv" | "pdf-table" | "text-lines" | "ai-chat" | "ai-vision";

/**
 * WHY a parse failed, in a form something can branch on.
 *
 * The distinction that matters downstream is whether running it again later
 * could plausibly do better:
 *
 *   ai_unavailable  a capability was missing or the provider failed. Configure
 *                   one and a replay genuinely gets you your items. RECOVERABLE.
 *   no_line_items   we read it and there was no receipt in it. A replay does
 *                   the same thing forever. DONE.
 *   unreadable      the bytes could not be read at all (a corrupt file, an
 *                   image-only PDF). Needs a different input, not a retry.
 *
 * Kept as a code rather than left in the prose `reason` because the caller has
 * to decide something with it, and deciding by matching on a human sentence is
 * a string comparison waiting to be reworded.
 */
export type ReceiptFailure = "ai_unavailable" | "no_line_items" | "unreadable";

export type ReceiptResult =
  | { ok: true; receipt: ParsedReceipt; method: ParseMethod }
  | { ok: false; reason: string; code: ReceiptFailure };

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    // Strip currency symbols, thousands separators, spaces; keep digits/./-.
    // A trailing/leading minus or parens (accounting negatives) → negative.
    const neg = /^\s*\(.*\)\s*$/.test(v) || /-/.test(v);
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Assemble + validate a receipt from loose parts. Returns null when there are
 *  no usable line items (a blank/garbled parse), so the caller can fall through
 *  to the next tier. Drops blank-description lines; defaults qty to 1. */
export function buildReceipt(parts: {
  vendor?: unknown;
  order_ref?: unknown;
  date?: unknown;
  currency?: unknown;
  total?: unknown;
  seller?: unknown;
  totals?: ReceiptTotals | null;
  expected_arrival?: unknown;
  items: Array<{
    description?: unknown;
    qty?: unknown;
    unit_price?: unknown;
    line_total?: unknown;
    discount?: unknown;
    code?: unknown;
  }>;
}): ParsedReceipt | null {
  const items: ReceiptLine[] = [];
  for (const it of parts.items) {
    const description = str(it.description);
    if (!description) continue;
    const discount = num(it.discount);
    // Digits only, and long enough to be a product code rather than a quantity
    // or a shelf tag. A till abbreviates wildly but never invents digits, so the
    // conservative floor is worth more than catching a 4-digit PLU.
    const rawCode = str(it.code)?.replace(/\D/g, "") ?? "";
    items.push({
      description: description.slice(0, 300),
      qty: num(it.qty) ?? 1,
      unit_price: num(it.unit_price),
      line_total: num(it.line_total),
      // Printed with a minus, reported either way round by different models.
      // What it MEANS is "this much came off", so store the magnitude.
      discount: discount === null ? null : Math.abs(discount),
      code: rawCode.length >= 8 && rawCode.length <= 14 ? rawCode : null,
    });
  }
  if (items.length === 0) return null;
  const currency = str(parts.currency);
  const total = num(parts.total);
  const lines_total = money(items.reduce((s, i) => s + lineNet(i), 0));
  return {
    vendor: str(parts.vendor),
    order_ref: cleanOrderRef(str(parts.order_ref)),
    date: isoDate(parts.date),
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    total,
    seller: str(parts.seller),
    totals: parts.totals ?? null,
    expected_arrival: isoDate(parts.expected_arrival),
    lines_total,
    // A cent of rounding is not a discrepancy; anything above it is.
    lines_reconcile: total === null ? null : Math.abs(lines_total - total) <= 0.01,
    items,
  };
}

/** Two decimal places, because summing floats does not stay money for long. */
function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Read what the LINE ITEMS cannot tell us out of the receipt's own text: the
 * money broken into components, who sold it, and when it should arrive.
 *
 * Separate from buildReceipt because the two AI paths hand us a model's JSON
 * rather than the receipt, and only some of them still hold the source text. A
 * parse with no text keeps its nulls, which is honest: these are read, never
 * inferred.
 */
export function enrichReceiptFromText(receipt: ParsedReceipt, text: string | null | undefined): ParsedReceipt {
  if (!text) return receipt;
  const totals = parseReceiptTotals(text);
  return {
    ...receipt,
    seller: receipt.seller ?? detectSeller(text, receipt.vendor),
    // Keep whatever the line parse already established; fill only the gaps.
    totals: receipt.totals ?? totals,
    expected_arrival: receipt.expected_arrival ?? parseEstimatedDelivery(text),
  };
}

/** Normalize a stated order/invoice number to a bare identifier: drop a leading
 *  "Order/Invoice/Ref/No." word + "#", cap length. Null when there's nothing. */
export function cleanOrderRef(ref: string | null): string | null {
  const c = (ref ?? "")
    .replace(/^(order|invoice|inv|ref(?:erence)?|no|number)\.?\s*#?\s*/i, "")
    .replace(/^#/, "")
    .trim()
    .slice(0, 40);
  return c || null;
}

/** A vendor name reduced to a comparison key: lowercase, alphanumerics only, so
 *  "KC Tool", "kc  tool", and "KC-Tool" all collapse to "kctool". */
export function normalizeVendorKey(vendor: string | null | undefined): string {
  return (vendor ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The identity of a receipt for duplicate detection: a store's order number is
 *  unique per vendor, so (normalized vendor, cleaned order #) names the receipt.
 *  Null when there's no order number to key on — without it we can't safely say
 *  two receipts are the same, so the caller must NOT dedup (avoids false hits). */
export function receiptDedupKey(
  vendor: string | null | undefined,
  orderRef: string | null | undefined,
): { vendor: string; orderRef: string } | null {
  const orderKey = cleanOrderRef(orderRef ?? null);
  if (!orderKey) return null;
  return { vendor: normalizeVendorKey(vendor), orderRef: orderKey };
}
