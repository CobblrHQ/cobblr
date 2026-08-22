// VOCAB-ENUMERATION OK: like receipt-facts.ts beside it, naming the receipt's
// own concepts is this file's entire job.
//
// Everything a receipt parse established, kept on the item it became.
//
// receipt-facts.ts answers "which of these has a MEANING the workspace has a
// field for", and a workspace with no such field gets an empty patch. That is
// the right behaviour for FIELDS - never invent a column nobody asked for - but
// it was also the only thing carrying receipt data forward, so everything with
// no field to land in was simply dropped.
//
// What that cost: a Lidl receipt dated the 18th, scanned on the 23rd, produced
// an item whose only date was the 23rd. Not in a field, not in metadata,
// nowhere - and for anything perishable the receipt's date is the one that
// matters (2026-08-22). The price the receipt reconciled, the vendor, the line
// total and the till's own product code went the same way.
//
// So the facts are RECORDED whether or not they have a home. A field is how you
// see and edit one; this is so the answer still exists to be queried, matched
// or promoted to a field later. The two layers are deliberate: this one never
// decides anything, it just refuses to forget.

/** The receipt keys `materializeReceiptLines` stamps on an inbox item. */
export interface ReceiptLineMeta {
  source?: unknown;
  receipt_group_id?: unknown;
  receipt_vendor?: unknown;
  receipt_seller?: unknown;
  receipt_date?: unknown;
  receipt_currency?: unknown;
  expected_arrival?: unknown;
  parse_method?: unknown;
  list_price?: unknown;
  discounts?: unknown;
  tax?: unknown;
  shipping?: unknown;
  total_charged?: unknown;
  net_price?: unknown;
  unit_price?: unknown;
  line_total?: unknown;
  discount?: unknown;
  code?: unknown;
}

/** What the receipt said, as recorded on the item it produced. */
export interface ReceiptRecord {
  /** The date ON the receipt, which is when this became yours - not when it
   *  was scanned. The whole reason this file exists. */
  date?: string;
  vendor?: string;
  seller?: string;
  currency?: string;
  /** The till's own product code for this line. Not a barcode, and not a
   *  transaction number: a vendor-scoped code worth keeping for a future
   *  catalog match. */
  code?: string;
  group_id?: string;
  parse_method?: string;
  expected_arrival?: string;
  unit_price?: number;
  line_total?: number;
  /** A coupon or markdown that belonged to THIS line. */
  discount?: number;
  net_price?: number;
  list_price?: number;
  discounts?: number;
  tax?: number;
  shipping?: number;
  total_charged?: number;
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : s;
};
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * The receipt's own record for one line, or null when this item did not come
 * from a receipt.
 *
 * Absent stays absent: a key that was never parsed is not written as null,
 * so "we did not read it" and "it said nothing" do not become the same answer.
 */
export function receiptRecord(meta: ReceiptLineMeta | null | undefined): ReceiptRecord | null {
  if (!meta) return null;
  const record: ReceiptRecord = {
    ...(str(meta.receipt_date) ? { date: str(meta.receipt_date)! } : {}),
    ...(str(meta.receipt_vendor) ? { vendor: str(meta.receipt_vendor)! } : {}),
    ...(str(meta.receipt_seller) ? { seller: str(meta.receipt_seller)! } : {}),
    ...(str(meta.receipt_currency) ? { currency: str(meta.receipt_currency)! } : {}),
    ...(str(meta.code) ? { code: str(meta.code)! } : {}),
    ...(str(meta.receipt_group_id) ? { group_id: str(meta.receipt_group_id)! } : {}),
    ...(str(meta.parse_method) ? { parse_method: str(meta.parse_method)! } : {}),
    ...(str(meta.expected_arrival) ? { expected_arrival: str(meta.expected_arrival)! } : {}),
    ...(num(meta.unit_price) !== undefined ? { unit_price: num(meta.unit_price)! } : {}),
    ...(num(meta.line_total) !== undefined ? { line_total: num(meta.line_total)! } : {}),
    ...(num(meta.discount) !== undefined ? { discount: num(meta.discount)! } : {}),
    ...(num(meta.net_price) !== undefined ? { net_price: num(meta.net_price)! } : {}),
    ...(num(meta.list_price) !== undefined ? { list_price: num(meta.list_price)! } : {}),
    ...(num(meta.discounts) !== undefined ? { discounts: num(meta.discounts)! } : {}),
    ...(num(meta.tax) !== undefined ? { tax: num(meta.tax)! } : {}),
    ...(num(meta.shipping) !== undefined ? { shipping: num(meta.shipping)! } : {}),
    ...(num(meta.total_charged) !== undefined ? { total_charged: num(meta.total_charged)! } : {}),
  };
  // A receipt line with nothing readable on it records nothing, rather than an
  // empty object on every item that ever passed through a scan.
  return Object.keys(record).length > 0 ? record : null;
}
