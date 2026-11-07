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

import { grocerNamedOn } from "./line-is-food.js";
import {
  buildReceipt,
  cleanOrderRef,
  enrichReceiptFromText,
  weightUnit,
  isMailTitle,
  isPhoneStatusBar,
  isReceiptHeading,
  isoDate,
  type ParsedReceipt,
} from "./receipt-shared.js";

/** Rows that are receipt STRUCTURE, not things you bought. Matched on the
 *  label after its amount is stripped. This is a document-structure vocabulary
 *  (the same kind of thing `classifyHeader` does for table columns), not an
 *  attempt to know what any product is.
 *
 *  The vocabulary and the line rules below are exported for one other reader,
 *  the receipt-shape check (receipt-shape.ts), which scores a text's
 *  receipt-ness from the same structure this parses. One definition. */
export const STRUCTURAL =
  /^(sub[\s-]?total|total|grand\s+total|amount\s+due|balance(\s+due)?|tax(es)?(\s*\d+)?|vat|gst|hst|pst|tip|gratuity|service\s+charge|shipping|delivery|handling|discount|change(\s+due)?|cash|cheque|check|tend(er(ed)?)?|debit|credit|visa|mastercard|master\s?card|amex|american\s+express|discover|paypal|gift\s?card|fsa(\s+card)?|hsa|ebt|store\s+credit|rounding|you\s+saved|savings?\s+today|total\s+savings?|items?\s+sold|item\s+count|auth(orization)?(\s+code)?|approval|ref(erence)?\s*(no|#)?|acct|account|card\s+#?|trans(action)?\s*(id|#)?|invoice|order\s+(no|#|number)|receipt\s*#?)\b/i;

/** A totals row that ENDS the item region. Everything after the first of these
 *  is bookkeeping — the tip, the card line, "YOU SAVED TODAY $3.00" — and must
 *  never become an item, whether or not its label is in STRUCTURAL. */
export const ENDS_ITEMS = /^(sub[\s-]?total|total|grand\s+total|amount\s+due|balance)\b/i;

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
export const QTY_AT = /(\d+(?:[.,]\d+)?)\s*([a-z]{1,6})?\s*@\s*[$€£¥]?\s*(\d+(?:[.,]\d+)?)/i;

/** The engine reads "lb" as "1b" or "b" often enough that "2.40 1b @ 3.10" would
 *  otherwise be a quantity of 1 (the "1" of "1b" beside the "@"). */
const OCR_LB = /(\d)\s+[1I|]?b\b/g;
/** The same "1b" run up against its number: "3.321b @ 1.29" is 3.32 lb. */
const OCR_LB_GLUED = /(\d[.,]\d{2})[1I|]b\b/g;
/** A leading zero read as a copyright mark, or lost: "@ $ ©.99", "@ .79". */
const OCR_ZERO = /(@\s*[$€£¥]?\s*)[©®]?(?=[.,]\d)/g;

function parseQtyAt(s: string): { qty: number; unit_price: number; unit: string | null } | null {
  const m = s.replace(OCR_ZERO, "$10").replace(OCR_LB_GLUED, "$1 lb").replace(OCR_LB, "$1 lb").match(QTY_AT);
  if (!m) return null;
  const qty = Number((m[1] ?? "").replace(",", "."));
  const unit = Number((m[3] ?? "").replace(",", "."));
  if (!Number.isFinite(qty) || !Number.isFinite(unit) || qty <= 0) return null;
  return { qty, unit_price: unit, unit: m[2] ?? null };
}

/** "2.62 lb 0 $ 3.25/lb": a weight and a rate with the "@" misread. The weight's
 *  unit and the "$" say what this is, and the caller checks the two multiply out
 *  to the line above before believing it (#9270). */
const WEIGHED_RATE = /^(\d+[.,]\d+)\s*(1b|ib|b|lbs?|kg|g|oz)\b\s*\S?\s*[$€£¥]\s*(\d+[.,]\d{2})\b/i;
const OCR_LB_WORD = /^(?:1b|ib|b|lbs?)$/i;

function parseWeighedRate(s: string, lineTotal: number | null): { weight: number; unit: string; rate: number } | null {
  const m = s.trim().match(WEIGHED_RATE);
  if (!m || lineTotal === null) return null;
  const weight = Number(m[1]!.replace(",", "."));
  const rate = Number(m[3]!.replace(",", "."));
  if (!(weight > 0) || Math.abs(weight * rate - lineTotal) > 0.02) return null;
  return { weight, unit: OCR_LB_WORD.test(m[2]!) ? "lb" : m[2]!.toLowerCase(), rate };
}

/** "2.0 @ 3.49" alone on a line: the count and rate of the item above, the rate
 *  sitting where the money reader looks for an amount. The engine reads the "@"
 *  as "0", "@0" or a stray mark, so the separator is loose here; what makes that
 *  safe is that count times rate has to equal the item's own price. A misread
 *  count ("2.6 @ 3.99" under 7.98) gives way to the price when the price divides
 *  by the rate exactly. */
const RATE_DETAIL = /^(\d+(?:[.,]\d+)?)\s*[@0©®e]+\s*[$€£¥]?\s*(\d+[.,]\d{2})\s*$/i;

/** A row of a date and nothing else, where a shop's name would be: an app's
 *  order screen is headed by the day. */
const DATE_ONLY = /^(?:[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/i;
/** The column headings of a receipt's table, not a shop. */
const COLUMN_HEADING = /^(?:description|item|items|qty|quantity|price|amount)(?:\s+(?:\$|€|£|¥|s|qty|quantity|price|amount|total))*$/i;

/** A discount row with no name of its own, printed under the item it comes off. */
const BARE_DISCOUNT = /^discount\b/i;

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
export const NOISE = /^[\s*=~_.-]*$/;

function detectCurrency(text: string): string | null {
  const m = text.match(/[$€£¥]|\b(USD|EUR|GBP|CAD|AUD|JPY)\b/);
  if (!m) return null;
  return CURRENCY[m[0]] ?? m[0].toUpperCase();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NAMED_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})\b/i;

export function detectDate(text: string): string | null {
  // OCR turns a leading 0 into @ or 9 often enough that anchoring on the
  // separators beats anchoring on the digits.
  const m = text.match(/\b(\d{4}-\d{2}-\d{2})\b/) ?? text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (m) return isoDate(m[1]!);
  // An app's order screen is headed by the day, spelled out: "Mar 14, 2026".
  const named = text.match(NAMED_DATE);
  if (!named) return null;
  const month = MONTHS.indexOf(named[1]!.toLowerCase()) + 1;
  return `${named[3]}-${String(month).padStart(2, "0")}-${named[2]!.padStart(2, "0")}`;
}

/** The reference a receipt prints for itself: "ORDER #77142", "Invoice
 *  88-2214", "Ref: A7Q-1190", "Transaction 000123456". The label names it and
 *  the token has a digit and some length; a bare "Receipt #12" counter, a
 *  date or a time after the label, and "ORDER OF FRIES" are not references.
 *  Read here because the tiers that reconcile the lines with no model have
 *  no other way to get it (#2964). */
export function detectOrderRef(text: string): string | null {
  const re = /(?:^|[\s|])(?:order|invoice|inv|receipt|ref(?:erence)?|transaction|trans|txn|ticket|confirmation)\s*(?:no\.?|number|num|id)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,29})(?![\w/:.])/gi;
  for (const m of text.matchAll(re)) {
    const token = m[1]!;
    if (!/\d/.test(token)) continue;
    if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(token) || /^\d{1,2}:\d{2}/.test(token)) continue;
    return cleanOrderRef(token);
  }
  return null;
}

/** The vendor is the first line with letters that isn't an address or a phone
 *  number. Receipts put the store name at the top, always. */
export function detectVendor(lines: string[]): string | null {
  for (const l of lines.slice(0, 4)) {
    const s = l.trim();
    if (s.length < 3 || s.length > 60) continue;
    if (!/[a-z]/i.test(s)) continue;
    if (isMailTitle(s) || isReceiptHeading(s)) continue;
    if (/^\d+\s/.test(s)) continue; // street address
    if (/\b(tel|phone|fax|www\.|http|store\s*#)\b/i.test(s)) continue;
    if (DATE_ONLY.test(s) || NAMED_DATE.test(s) || COLUMN_HEADING.test(s) || isPhoneStatusBar(s)) continue;
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
/** The weight-and-rate tail of a weighed item's line ("1.24 lb @ 0.95/lb",
 *  with OCR's "@.95" for "0.95"), dropped when that line lends its name to the
 *  price printed under it. */
const WEIGHED_DETAIL = /\s+\d+(?:[.,]\d+)?\s*(?:lb|lbs|kg|g|oz)\b.*$/i;
const WRAP_LABEL = "wrapped";

export function parseTextReceipt(text: string): TextReceiptParse | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  if (lines.length < 4) return null;

  const items: Array<{ description: string; qty: number; unit_price: number | null; line_total: number; discount: number; bare_discount: number; weight?: number; weight_unit?: string }> = [];
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
      // A price the till wrapped onto a line of its own, under the name it
      // belongs to: a weighed item prints "BANANAS 1.24 lb @ 0.95/lb" and then
      // "1.18" (#4027: a three-line grocery receipt came out a line short of
      // its subtotal and was refused). The money reader refuses a bare price
      // on purpose, so it is asked about the price under a stand-in label.
      // The weight detail is not the name.
      const wrapped = pendingDescription && !itemsClosed ? readTrailingAmount(`${WRAP_LABEL} ${line}`) : null;
      if (wrapped && wrapped.label === WRAP_LABEL && wrapped.amount > 0) {
        const description = pendingDescription!.replace(WEIGHED_DETAIL, "").trim();
        if (/[a-z]/i.test(description)) {
          items.push({ description, qty: 1, unit_price: wrapped.amount, line_total: wrapped.amount, discount: 0, bare_discount: 0 });
          pendingDescription = null;
          continue;
        }
      }
      // No amount: it may still be the "2.16 lb @ 0.58 /lb" detail line that
      // belongs to the item above it. A receipt puts that BELOW its item.
      const qa = parseQtyAt(line);
      const last = items[items.length - 1];
      if (qa && last && !itemsClosed) {
        last.qty = qa.qty;
        last.unit_price = qa.unit_price;
        // Sold by weight: 1.60 lb is one squash, not "2 of the same".
        if (weightUnit(qa.unit)) {
          last.weight = qa.qty;
          last.weight_unit = qa.unit!;
        }
        continue;
      }
      const weighed = last && !itemsClosed ? parseWeighedRate(line, last.line_total) : null;
      if (weighed && last) {
        last.qty = weighed.weight;
        last.unit_price = weighed.rate;
        last.weight = weighed.weight;
        last.weight_unit = weighed.unit;
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
    // The vocabulary below calls "Discount" bookkeeping, which it is at the foot
    // of a receipt. Above the totals, with money coming off, it belongs to the
    // item over it: "Discount -0.40" dropped here left an app's receipt dollars over
    // its own subtotal, and the whole read went to a model that was not answering.
    const previous = items[items.length - 1];
    if (hit.amount < 0 && BARE_DISCOUNT.test(label) && previous) {
      previous.discount += Math.abs(hit.amount);
      previous.bare_discount += Math.abs(hit.amount);
      continue;
    }
    const rate = line.match(RATE_DETAIL);
    if (rate && previous) {
      const qty = Number((rate[1] ?? "").replace(",", "."));
      const unit = Number((rate[2] ?? "").replace(",", "."));
      const counted = unit > 0 ? Math.round(previous.line_total / unit) : 0;
      if (qty > 0 && Math.abs(qty * unit - previous.line_total) <= 0.01) {
        previous.qty = qty;
        previous.unit_price = unit;
        continue;
      }
      if (counted >= 2 && Math.abs(counted * unit - previous.line_total) <= 0.01) {
        previous.qty = counted;
        previous.unit_price = unit;
        continue;
      }
    }
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
    // A NEGATIVE amount is money coming back off: a coupon, a member discount,
    // a price override. It is not something anyone bought, so it never becomes
    // an item — it attaches to the line above it, which is the one it discounts.
    // (The noise filter cannot catch these: it matches on labels like "discount"
    // and a real receipt prints "Lidl Points Coupon", which starts with a shop's
    // name and looks exactly like an item until you notice the minus.)
    if (hit.amount < 0) {
      const prev = items[items.length - 1];
      // Before any item, it discounts the whole order rather than a line. The
      // grand total already accounts for it, so there is nothing to attach.
      if (prev) prev.discount += Math.abs(hit.amount);
      continue;
    }
    items.push({ description, qty, unit_price, line_total: hit.amount, discount: 0, bare_discount: 0 });
  }

  if (items.length < 2) return null;

  // The self-check. Items must add up to the subtotal (or, when a receipt
  // prints no subtotal, to the total). Within a cent per line, because OCR and
  // rounding both cost fractions.
  const expectedAgainst: "subtotal" | "total" = subtotal !== null ? "subtotal" : "total";
  const expected = subtotal ?? grandTotal ?? total;
  if (expected === null || expected === undefined) return null;
  const tolerance = Math.max(0.02, items.length * 0.01);
  const sumOf = (rows: typeof items) => Math.round(rows.reduce((s, i) => s + i.line_total - i.discount, 0) * 100) / 100;
  let sum = sumOf(items);
  let delta = Math.round((sum - expected) * 100) / 100;
  // A till can print a bare discount and still subtotal before it. The arithmetic
  // says which this receipt is: if the items only add up without those rows, they
  // were not taken off yet, so they are not on the lines.
  if (Math.abs(delta) > tolerance && items.some((i) => i.bare_discount > 0)) {
    for (const i of items) i.discount -= i.bare_discount;
    sum = sumOf(items);
    delta = Math.round((sum - expected) * 100) / 100;
  }
  if (Math.abs(delta) > tolerance) return null;

  const receipt = buildReceipt({
    vendor: detectVendor(lines) ?? grocerNamedOn(lines),
    order_ref: null,
    date: detectDate(text),
    currency: detectCurrency(text),
    total: grandTotal ?? total ?? subtotal,
    items: items.map((i) => ({
      description: i.description,
      qty: i.qty,
      unit_price: i.unit_price,
      line_total: i.line_total,
      discount: i.discount || null,
      ...(i.weight ? { weight: i.weight, weight_unit: i.weight_unit } : {}),
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
