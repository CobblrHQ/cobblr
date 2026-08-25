// The numbers at the bottom of a receipt, read as components rather than as
// "the price".
//
// A receipt carries several numbers that all look like the price, and picking
// one is how the current parser gets it wrong. A real order confirmation read:
//
//     Subtotal            164.51
//     Shipping              free
//     Sales tax            10.90
//     Coupons, discounts  -16.45
//     Total charged       158.96
//
// and 164.51 was recorded as what the thing cost. It is neither what the item
// cost (148.06, once the coupon comes off) nor what left the account (158.96).
// "What did I pay for this" was answered wrongly by 5.55, silently, with nothing
// marking the number as a list price rather than a payment.
//
// So: keep the components, derive the useful one, and REFUSE when they do not
// add up. The identity below is a CHECK, never a formula to fill a gap with.
// A receipt we misread should produce nothing and let a person type it, because
// a plausible wrong number is worse than an obvious missing one.
//
// Lives in the contract (as its own exports subpath) because core-scan owns the
// receipt parse and a module may not import api internals.
//
// See docs/design-decisions/arrivals.md.

/** A money line, as read. */
export interface TotalsComponents {
  /** The pre-discount, pre-tax sum of the lines. */
  subtotal: number | null;
  /** Every reduction found, kept separately: an order can carry several and
   *  they are not interchangeable (a coupon on one item vs a store credit). */
  discounts: number[];
  tax: number | null;
  shipping: number | null;
  /** What actually left the account. */
  totalCharged: number | null;
}

export interface ReceiptTotals extends TotalsComponents {
  /** subtotal minus discounts, before tax: what the ITEM cost you. Null when
   *  the components do not reconcile, which is the whole point. */
  netPrice: number | null;
  /** Did `net + tax + shipping` land on `totalCharged`? */
  reconciled: boolean;
  /** Present when it did not, for a human to read. */
  discrepancy?: number;
}

/**
 * Label patterns, as DATA.
 *
 * Vendors phrase these differently and there is no standard, so the table grows
 * by a row rather than by a branch. Order matters only in that the first match
 * on a line wins, so the more specific patterns come first: "total charged"
 * must beat "total", and "subtotal" must not be eaten by "total".
 */
const LABELS: Array<{ re: RegExp; part: keyof TotalsComponents }> = [
  { re: /\b(?:sub[\s-]?total|item[s]?\s+total|merchandise)\b/i, part: "subtotal" },
  { re: /\b(?:total\s+charged|amount\s+(?:charged|paid)|grand\s+total|order\s+total|you\s+paid)\b/i, part: "totalCharged" },
  // Plurals are the norm on a receipt ("Coupons, discounts, gift cards"), and a
  // trailing \b after a singular silently fails on every one of them: the label
  // never matches, the amount is never read, and the net price is quietly the
  // list price. Every pluralisable word carries its own `s?`.
  // `tax(?:es)?`, NOT `taxes?`: the latter reads as "taxe" plus an optional s
  // and so matches neither "Tax" nor "Taxes". It silently dropped every tax
  // line, which then failed reconciliation and withheld the price entirely.
  { re: /\b(?:sales\s+tax(?:es)?|vat|gst|hst|tax(?:es)?)\b/i, part: "tax" },
  { re: /\b(?:shipping|delivery|postage|freight)\b/i, part: "shipping" },
  {
    re: /\b(?:coupons?|discounts?|promo(?:tion)?s?|savings?|gift\s*cards?|credits?|vouchers?|rebates?)\b/i,
    part: "discounts",
  },
];

/** Which component a line's label names, or null. Exported so a test can hold
 *  the label table to a matrix of real phrasings: a pattern that matches
 *  nothing is invisible at runtime (the amount is simply never read, and the
 *  price quietly comes out wrong) and both bugs found while writing this were
 *  exactly that. */
export function labelFor(line: string): keyof TotalsComponents | null {
  return LABELS.find((l) => l.re.test(line))?.part ?? null;
}

/** Every component the label table can produce, so a test can prove each one is
 *  covered rather than assuming. */
export const LABELLED_PARTS = [...new Set(LABELS.map((l) => l.part))];

/** Money on a line. Handles $1,234.56, 1234.56, and the unicode minus vendors
 *  love. Returns the LAST number on the line, because a label can carry its own
 *  digits ("10% off" then the amount). */
/**
 * One string of digits and separators -> an amount, in either separator
 * convention. "1.234,56" and "1,234.56" are the same amount; the decimal
 * separator is the LAST one, except a lone separator before exactly three
 * digits, which reads as a thousands group when it is a comma and as a decimal
 * when it is a dot ("3.599"/gal is a price; "1,234" is not 1.234).
 *
 * Exported because receipt money is read in two places - the totals block here
 * and the line coercion in core-scan - and two copies of this rule WILL drift;
 * the old copies disagreed about "1.234,56" by a factor of a thousand.
 */
export function moneyValue(raw: string): number | null {
  const digits = raw.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return null;
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  let normal: string;
  if (sep === -1) {
    normal = digits;
  } else {
    const frac = digits.slice(sep + 1);
    const both = lastDot !== -1 && lastComma !== -1;
    const decimal = both || frac.length !== 3 || sep === lastDot;
    normal = decimal
      ? digits.slice(0, sep).replace(/[.,]/g, "") + "." + frac
      : digits.replace(/[.,]/g, "");
  }
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

function moneyOn(line: string): number | null {
  // "free" is a real, and common, zero.
  if (/\bfree\b/i.test(line) && !/[\d]/.test(line.replace(/\bfree\b/i, ""))) return 0;
  const matches = [...line.matchAll(/(-|−|–)?\s*[$£€]?\s*(\d[\d.,]*)/g)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1]!;
  const n = moneyValue(m[2]!);
  if (n === null) return null;
  return m[1] ? -n : n;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Read the totals block out of a receipt's text.
 *
 * Deliberately forgiving about layout and strict about arithmetic: it will find
 * numbers in almost any phrasing, and then refuse to publish a net price unless
 * they agree with each other.
 */
export function parseReceiptTotals(text: string): ReceiptTotals {
  const parts: TotalsComponents = {
    subtotal: null,
    discounts: [],
    tax: null,
    shipping: null,
    totalCharged: null,
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hit = LABELS.find((l) => l.re.test(line));
    if (!hit) continue;
    const amount = moneyOn(line);
    if (amount == null) continue;

    if (hit.part === "discounts") {
      // A discount is a reduction however the vendor signed it.
      const abs = Math.abs(amount);
      if (abs > 0) parts.discounts.push(abs);
      continue;
    }
    // First occurrence wins: a summary block near the top beats a repeat in the
    // footer, and repeated labels should not accumulate.
    if (parts[hit.part] == null) parts[hit.part] = amount;
  }

  const discountTotal = round2(parts.discounts.reduce((a, b) => a + b, 0));
  const canDerive = parts.subtotal != null;
  const net = canDerive ? round2(parts.subtotal! - discountTotal) : null;

  // The identity. It decides whether we believe the parse; it never fills a gap.
  let reconciled = false;
  let discrepancy: number | undefined;
  if (net != null && parts.totalCharged != null) {
    const expected = round2(net + (parts.tax ?? 0) + (parts.shipping ?? 0));
    const delta = round2(expected - parts.totalCharged);
    reconciled = Math.abs(delta) <= 0.01;
    if (!reconciled) discrepancy = delta;
  }

  return {
    ...parts,
    // A number we cannot corroborate is not offered. Someone typing the price
    // themselves is a smaller cost than a wrong price nobody notices.
    netPrice: reconciled ? net : null,
    reconciled,
    ...(discrepancy !== undefined ? { discrepancy } : {}),
  };
}

/** Month names, so a date needs no locale machinery to read. */
const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/**
 * "Estimated delivery: Sat, Aug 15" as an ISO date.
 *
 * The year is usually absent, so it is inferred as the next occurrence at or
 * after `today`: a delivery date is in the future by definition, and reading a
 * December estimate in January as eleven months ago would put it on the wrong
 * side of every "has it arrived" question.
 */
export function parseEstimatedDelivery(text: string, today = new Date()): string | null {
  const m = /(?:estimated|expected|arriv\w*|deliver\w*)[^\n]{0,40}?\b(?:by\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*([a-z]{3,9})\.?\s+(\d{1,2})\b|(?:estimated|expected)\s+deliver\w*:?\s*\n*\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?([a-z]{3,9})\.?\s+(\d{1,2})\b/i.exec(
    text,
  );
  if (!m) return null;
  const monthWord = (m[1] ?? m[3] ?? "").slice(0, 3).toLowerCase();
  const day = Number(m[2] ?? m[4]);
  const month = MONTHS.indexOf(monthWord);
  if (month < 0 || !Number.isFinite(day) || day < 1 || day > 31) return null;

  const base = new Date(Date.UTC(today.getUTCFullYear(), month, day));
  // Roll to next year only when the date is meaningfully in the past, so a
  // delivery estimated for yesterday still reads as this year.
  const cutoff = new Date(today.getTime() - 3 * 86_400_000);
  if (base < cutoff) base.setUTCFullYear(base.getUTCFullYear() + 1);
  return base.toISOString().slice(0, 10);
}

/**
 * Who sold it, when that differs from where you bought it.
 *
 * On a marketplace these are two facts: eBay is where you shop again, and the
 * individual seller may never come up twice. A shop's own receipt names only
 * itself, and this returns null there rather than echoing the vendor, because
 * "Home Depot sold by Home Depot" is noise a caller would have to strip.
 *
 * Label-driven, like the totals: vendors phrase it a handful of ways and the
 * table grows by a row.
 */
// `(.*)` and not `(.+)`: a bare "Seller:" on its own line is the common layout
// once an HTML mail is flattened, and requiring a character after the colon
// makes that pattern fail outright, so the next-line lookahead below is never
// reached and the seller is silently lost.
const SELLER_LABELS = [
  /\bsold\s+by\s*:?\s*(.*)$/i,
  /\bsellers?\s*:\s*(.*)$/i,
  /\bshop\s*:\s*(.*)$/i,
  /\bstore\s*:\s*(.*)$/i,
];

export function detectSeller(text: string, vendor?: string | null): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    for (const re of SELLER_LABELS) {
      const m = re.exec(line);
      if (!m) continue;
      let value = (m[1] ?? "").trim();
      // A label alone on its line ("Seller:") puts the name on the next one,
      // which is how a marketplace lays it out in plain text.
      if (!value) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const next = (lines[j] ?? "").trim();
          // Skip the link lines that follow a name in a converted HTML mail.
          if (!next || /^<?https?:\/\//i.test(next)) continue;
          value = next;
          break;
        }
      }
      value = value
        .replace(/<[^>]*>/g, "")
        .replace(/[<>|].*$/, "")
        .replace(/\s{2,}.*$/, "")
        .trim()
        .slice(0, 80);
      if (!value) continue;
      // Echoing the vendor back is not a second fact.
      if (vendor && value.toLowerCase() === vendor.toLowerCase()) return null;
      return value;
    }
  }
  return null;
}
