// Deterministic receipt parsing from plain TEXT — the tier between the PDF
// table reader and the AI fallback. NO AI.
//
// A till receipt is not a ruled table, so `pdf-parse`'s getTable() finds
// nothing in one and we've been handing the whole job to a model. But a receipt
// IS strongly structured, just line-wise instead of column-wise: a line is a
// description followed by its amount, the item region ends at the first totals
// row, and the items must add up to the subtotal. That last property is the
// point — it gives this parser a SELF-CHECK an AI parse can never have. When
// the arithmetic doesn't reconcile we return null and let AI have it, so a
// confident-but-wrong deterministic read can't win.
//
// Feeds three callers that all reach AI today:
//   • a text PDF whose table extraction found nothing
//   • an emailed receipt body (HTML stripped to text)
//   • OCR output from a photo, once an engine is wired up
//
// Column whitespace is NOT a signal here: OCR collapses runs of spaces, so
// "MILK        3.68" comes back as "MILK 3.68". Everything below keys off the
// END of the line instead.

import {
  buildReceipt,
  enrichReceiptFromText,
  isoDate,
  type ParsedReceipt,
} from "./receipt-shared.js";

/** Rows that are receipt STRUCTURE, not things you bought. Matched on the
 *  label after its amount is stripped. This is a document-structure vocabulary
 *  (the same kind of thing `classifyHeader` does for table columns), not an
 *  attempt to know what any product is. */
const STRUCTURAL =
  /^(sub[\s-]?total|total|grand\s+total|amount\s+due|balance(\s+due)?|tax(es)?(\s*\d+)?|vat|gst|hst|pst|tip|gratuity|service\s+charge|shipping|delivery|handling|discount|change(\s+due)?|cash|cheque|check|tend(er(ed)?)?|debit|credit|visa|mastercard|master\s?card|amex|american\s+express|discover|paypal|gift\s?card|fsa(\s+card)?|hsa|ebt|store\s+credit|rounding|you\s+saved|savings?\s+today|total\s+savings?|items?\s+sold|item\s+count|auth(orization)?(\s+code)?|approval|ref(erence)?\s*(no|#)?|acct|account|card\s+#?|trans(action)?\s*(id|#)?|invoice|order\s+(no|#|number)|receipt\s*#?)\b/i;

/** A totals row that ENDS the item region. Everything after the first of these
 *  is bookkeeping — the tip, the card line, "YOU SAVED TODAY $3.00" — and must
 *  never become an item, whether or not its label is in STRUCTURAL. */
const ENDS_ITEMS = /^(sub[\s-]?total|total|grand\s+total|amount\s+due|balance)\b/i;

/** The grand total, in preference order — "grand total" beats "total" when a
 *  receipt prints both (a tipped restaurant bill prints both, and they differ). */
const GRAND_TOTAL = /^(grand\s+total|amount\s+due|balance\s+due)\b/i;
const PLAIN_TOTAL = /^total\b/i;
const SUBTOTAL = /^sub[\s-]?total\b/i;

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/**
 * Read a money token off the END of a string.
 *
 * Tolerates what OCR actually does to prices: a decimal point read as a comma
 * ("1,25"), a stray currency symbol, parenthesised or trailing-minus negatives,
 * and the single-letter tax flag chains ("3.47 F", "21.99 E", "9.97 TF") that
 * grocery and warehouse tills print after the amount.
 */
export function readTrailingAmount(line: string): { label: string; amount: number } | null {
  const m = line.match(
    /^(.*?)[\s.]*(\(?\s*[-−]?\s*[$€£¥]?\s*\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,3})?\s*\)?)\s*(?:[A-Z]{1,2})?\s*[-−]?\s*$/,
  );
  if (!m) return null;
  const label = (m[1] ?? "").trim();
  const raw = (m[2] ?? "").trim();
  // A bare integer with no decimal part is a count, a store number, a year — not
  // a price. Requiring the cents is what keeps "STORE #4471" out of the items.
  if (!/[.,]\d{1,3}\s*\)?\s*$/.test(raw)) return null;

  const negative = /^\(/.test(raw) || /[-−]/.test(raw) || /[-−]\s*$/.test(line);
  let digits = raw.replace(/[()$€£¥\s−-]/g, "");
  // A comma before exactly 3 digits is a thousands separator; before 1-2 it's
  // a decimal point OCR misread ("1,25"). Both appear in the same corpus.
  digits = /,\d{3}(?:\D|$)/.test(digits) ? digits.replace(/,/g, "") : digits.replace(/,/g, ".");
  // More than one separator left means thousands + decimal ("1.234.56" from a
  // misread) — keep the LAST as the decimal point.
  const parts = digits.split(".");
  if (parts.length > 2) digits = `${parts.slice(0, -1).join("")}.${parts[parts.length - 1]}`;

  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (!label) return null;
  return { label, amount: negative ? -Math.abs(value) : value };
}

/** "12 @ 3.98", "2.16 lb @ 0.58 /lb", "13.442 GAL @ 3.551 /GAL" — the
 *  quantity-times-unit-price form, wherever it appears. */
const QTY_AT = /(\d+(?:[.,]\d+)?)\s*([a-z]{1,6})?\s*@\s*[$€£¥]?\s*(\d+(?:[.,]\d+)?)/i;

function parseQtyAt(s: string): { qty: number; unit_price: number } | null {
  const m = s.match(QTY_AT);
  if (!m) return null;
  const qty = Number((m[1] ?? "").replace(",", "."));
  const unit = Number((m[3] ?? "").replace(",", "."));
  if (!Number.isFinite(qty) || !Number.isFinite(unit) || qty <= 0) return null;
  return { qty, unit_price: unit };
}

/** Strip a leading SKU / item number (6+ digits) — a warehouse club prints one
 *  on every line and it is not part of the product's name.
 *
 *  The character class is deliberately loose: OCR reads a leading zero as "@",
 *  "O", "Q" or "9" often enough that an exact \d{6,} leaves "@28841" glued to
 *  the front of every line on a contractor receipt. A 6+ run of digits-and-
 *  confusables followed by a space is a SKU whichever way the zero came out. */
function stripSku(label: string): string {
  return label.replace(/^\s*#?[\d@OQoDIl|]{6,}\s+(?=\S)/, "").trim();
}

/** Strip a leading quantity ("2  HOUSE BURGER") and report it. Capped at two
 *  digits so a year or a SKU can't be mistaken for a count. */
function leadingQty(label: string): { qty: number; label: string } {
  const m = label.match(/^(\d{1,2})\s+(\D.*)$/);
  if (!m) return { qty: 1, label };
  return { qty: Number(m[1]), label: (m[2] ?? "").trim() };
}

/** Junk a receipt prints that carries no amount and no meaning for us. */
const NOISE = /^[\s*=~_.-]*$/;

function detectCurrency(text: string): string | null {
  const m = text.match(/[$€£¥]|\b(USD|EUR|GBP|CAD|AUD|JPY)\b/);
  if (!m) return null;
  return CURRENCY[m[0]] ?? m[0].toUpperCase();
}

function detectDate(text: string): string | null {
  // OCR turns a leading 0 into @ or 9 often enough that anchoring on the
  // separators beats anchoring on the digits.
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return m ? isoDate(m[1]!) : null;
}

/** The vendor is the first line with letters that isn't an address or a phone
 *  number. Receipts put the store name at the top, always. */
function detectVendor(lines: string[]): string | null {
  for (const l of lines.slice(0, 4)) {
    const s = l.trim();
    if (s.length < 3 || s.length > 60) continue;
    if (!/[a-z]/i.test(s)) continue;
    if (/^\d+\s/.test(s)) continue; // street address
    if (/\b(tel|phone|fax|www\.|http|store\s*#)\b/i.test(s)) continue;
    if (readTrailingAmount(s)) continue;
    return s;
  }
  return null;
}

export interface TextReceiptParse {
  receipt: ParsedReceipt;
  /** Σ line totals, and what it was checked against. Surfaced so the caller can
   *  explain WHY a parse was accepted. */
  reconciliation: { sum: number; expected: number; against: "subtotal" | "total"; delta: number };
}

/**
 * Parse a receipt out of plain text. Returns null the moment it isn't
 * confident — no items, no totals row to check against, or arithmetic that
 * doesn't reconcile — so the caller falls through to AI rather than shipping a
 * wrong answer that looks right.
 */
export function parseTextReceipt(text: string): TextReceiptParse | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  if (lines.length < 4) return null;

  const items: Array<{ description: string; qty: number; unit_price: number | null; line_total: number }> = [];
  let subtotal: number | null = null;
  let total: number | null = null;
  let grandTotal: number | null = null;
  let itemsClosed = false;
  // A wide receipt (a contractor desk, a parts invoice) prints the description
  // on its own line and the "12 @ 3.98    47.76" arithmetic underneath it. The
  // amount-bearing line then has no name of its own, so hold the last bare
  // description in case the next priced line needs to borrow it.
  let pendingDescription: string | null = null;

  for (const line of lines) {
    const hit = readTrailingAmount(line);

    if (!hit) {
      // No amount: it may still be the "2.16 lb @ 0.58 /lb" detail line that
      // belongs to the item above it. A receipt puts that BELOW its item.
      const qa = parseQtyAt(line);
      const last = items[items.length - 1];
      if (qa && last && !itemsClosed) {
        last.qty = qa.qty;
        last.unit_price = qa.unit_price;
        continue;
      }
      const bare = stripSku(line).replace(/[\s.:-]+$/, "").trim();
      if (!qa && !itemsClosed && bare && /[a-z]/i.test(bare) && !STRUCTURAL.test(bare)) {
        pendingDescription = bare;
      }
      continue;
    }

    const label = hit.label;

    if (SUBTOTAL.test(label)) subtotal ??= hit.amount;
    if (GRAND_TOTAL.test(label)) grandTotal = hit.amount;
    else if (PLAIN_TOTAL.test(label)) total ??= hit.amount;

    if (ENDS_ITEMS.test(label)) {
      itemsClosed = true;
      continue;
    }
    if (itemsClosed) continue;
    if (STRUCTURAL.test(label)) continue;

    // An item. Its own line may carry the qty-times-unit form, in which case
    // the trailing amount is the EXTENDED total, not the unit price.
    const sameLineQty = parseQtyAt(label);
    const withoutSku = stripSku(sameLineQty ? label.replace(QTY_AT, "").trim() : label);
    const { qty: prefixQty, label: cleaned } = sameLineQty
      ? { qty: sameLineQty.qty, label: withoutSku }
      : leadingQty(withoutSku);

    let description = cleaned.replace(/[\s.:-]+$/, "").trim();
    // A line whose whole label was the qty-times-unit arithmetic borrows the
    // description printed above it ("2X4X8 STUD" / "12 @ 3.98   47.76").
    if ((!description || !/[a-z]{2}/i.test(description)) && sameLineQty && pendingDescription) {
      description = pendingDescription;
    }
    if (!description || !/[a-z]/i.test(description)) continue;
    pendingDescription = null;

    const qty = sameLineQty ? sameLineQty.qty : prefixQty;
    const unit_price = sameLineQty
      ? sameLineQty.unit_price
      : qty > 1
        ? Math.round((hit.amount / qty) * 1000) / 1000
        : hit.amount;
    items.push({ description, qty, unit_price, line_total: hit.amount });
  }

  if (items.length < 2) return null;

  // The self-check. Items must add up to the subtotal (or, when a receipt
  // prints no subtotal, to the total). Within a cent per line, because OCR and
  // rounding both cost fractions.
  const expectedAgainst: "subtotal" | "total" = subtotal !== null ? "subtotal" : "total";
  const expected = subtotal ?? grandTotal ?? total;
  if (expected === null || expected === undefined) return null;
  const sum = Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
  const delta = Math.round((sum - expected) * 100) / 100;
  const tolerance = Math.max(0.02, items.length * 0.01);
  if (Math.abs(delta) > tolerance) return null;

  const receipt = buildReceipt({
    vendor: detectVendor(lines),
    order_ref: null,
    date: detectDate(text),
    currency: detectCurrency(text),
    total: grandTotal ?? total ?? subtotal,
    items: items.map((i) => ({
      description: i.description,
      qty: i.qty,
      unit_price: i.unit_price,
      line_total: i.line_total,
    })),
  });
  if (!receipt) return null;

  return {
    // The line items say WHAT was bought; the text below them says what it cost
    // after discounts, who sold it, and when it lands. Read here because this is
    // the last point that still has the receipt itself rather than a summary.
    receipt: enrichReceiptFromText(receipt, text),
    reconciliation: { sum, expected, against: expectedAgainst, delta },
  };
}
