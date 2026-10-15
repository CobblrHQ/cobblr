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
  /** The MANUFACTURER's model number for the line, when the receipt prints one
   *  ("Model #: GA605WI-XS96"). Alphanumeric, so it is a different fact from
   *  `code` above, which is digits-only by design: a UPC identifies the package
   *  a shop sold, a model identifies the thing itself across every shop that
   *  sells it.
   *
   *  Online order emails print it routinely and it was being read straight past
   *  - a Best Buy email listed a Model # that reached nothing (2026-08-24).
   *  Kept because it is the most durable handle on a machine: warranties,
   *  manuals, spare parts and a future catalog match all key on it. */
  model: string | null;
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
  /** This line's share of a discount taken off the whole ORDER (a code like
   *  WEL05, 10% of the subtotal), as a positive number. Kept apart from
   *  `discount`, which was printed under the line: the order record wants
   *  what each line cost after the code, and the card wants to say why
   *  (shareOrderDiscount). */
  order_discount?: number | null;
  /** For a line sold BY WEIGHT: the weight printed on the line ("4.14 lb"),
   *  and its unit. `qty` is then 1 - it is one package - and `unit_price` is
   *  the per-unit price ($/lb). Null for anything sold by count. Kept because
   *  "$1.99/lb" is the number worth knowing next time, and a weight rounded
   *  into a count of four is simply wrong (2026-09-06). */
  weight: number | null;
  weight_unit: "lb" | "kg" | "oz" | "g" | null;
  /** What the document says about THIS thing, keyed by field role (its VIN
   *  as `identifier`, its year, its odometer as `usage`). Filled by a reader
   *  that knows the document (a bill of sale); filing lands each on the
   *  field that declares the role. */
  facts?: RoledFacts;
  /** What the line is when it is not a thing you now have. A `charge` (a
   *  fee, a tax, a delivery charge, a service) and an `add-on` (an extra on a
   *  bill of sale, like wheel locks) stay lines on the purchase and are never
   *  made into inbox items; an add-on can be promoted from the purchase.
   *  Absent: a thing. */
  kind?: "charge" | "add-on";
  /** Who made the thing, when the document prints it (a bill of sale's
   *  Make). The row's suggested manufacturer, which filing carries to the
   *  record's own manufacturer. */
  manufacturer?: string | null;
  /** An identifier the document printed for this thing (a VIN) with what it
   *  said about it (year, make, model), in the shape an identifier decode
   *  takes, so the record's fields fill through the same decode roles a
   *  scanned VIN fills. */
  decoded?: { decoder_id: string; code: string; fields: Record<string, string | number> };
}

/** How many of the thing a line is. One, when it was sold by weight: 4.14 lb of
 *  chicken is one package, and rounding it to four was recording four. */
export function lineQuantity(line: Pick<ReceiptLine, "qty" | "weight">): number {
  if (line.weight !== null && line.weight !== undefined && line.weight > 0) return 1;
  return filedQuantityOf(line.qty);
}

const WEIGHT_UNITS = new Set(["lb", "kg", "oz", "g"]);
/** A unit the model wrote, normalised to the four this understands, or null. */
export function weightUnit(v: unknown): ReceiptLine["weight_unit"] {
  const u = typeof v === "string" ? v.trim().toLowerCase().replace(/s$|\.$/, "") : "";
  const norm = u === "lbs" || u === "pound" ? "lb" : u === "kilo" || u === "kilogram" ? "kg" : u === "ounce" ? "oz" : u === "gram" ? "g" : u;
  return WEIGHT_UNITS.has(norm) ? (norm as ReceiptLine["weight_unit"]) : null;
}

/** What a line actually cost: rung-up price less anything taken off it. */
export function lineNet(l: ReceiptLine): number {
  // In cents: 87.99 - 8.79 in floats is 79.19999999999999, and that is what a
  // line's stored net and the order's line amount read (#5350, staging).
  return amountOf((centsFromAmount(l.line_total ?? 0) - centsFromAmount(l.discount ?? 0) - centsFromAmount(l.order_discount ?? 0)) as Cents);
}

/** Money came off this line, under it or as its share of the order's. */
export function lineDiscounted(l: Pick<ReceiptLine, "discount" | "order_discount">): boolean {
  return !!l.discount || !!l.order_discount;
}

/**
 * A discount on the whole order, shared across its item lines in proportion
 * to what each was rung up at, to the cent (#5350). A Kingroon order took
 * 10% (WEL05, -25.62) off three lines of 80.30, 87.99 and 87.99; each line's
 * cost is what it cost after the code, and the shares add up to exactly the
 * discount (the largest remainders take the odd cents).
 *
 * Only when it is safe to say: the totals reconciled, no line carries a
 * discount of its own (then the order's figure may be those), and the item
 * lines add up to the subtotal the discount came off. Otherwise the receipt
 * is returned as it was, and the lines keep their rung-up prices.
 */
export function shareOrderDiscount(receipt: ParsedReceipt): ParsedReceipt {
  const t = receipt.totals;
  const off: number = centsFromAmount((t?.discounts ?? []).reduce((s, d) => s + Math.abs(d), 0));
  if (!t || !t.reconciled || off <= 0 || t.subtotal === null) return receipt;
  const items = receipt.items.map((l, i) => ({ l, i })).filter(({ l }) => !l.kind);
  if (!items.length || items.some(({ l }) => l.discount || l.order_discount || l.line_total === null)) return receipt;
  const cents: number[] = items.map(({ l }) => centsFromAmount(l.line_total!));
  const sum = cents.reduce((s, c) => s + c, 0);
  if (sum <= 0 || Math.abs(sum - centsFromAmount(t.subtotal)) > 1 || off >= sum) return receipt;
  const exact = cents.map((c) => (c * off) / sum);
  const share = exact.map(Math.floor);
  let left = off - share.reduce((s, c) => s + c, 0);
  const byRemainder = exact.map((e, k) => ({ k, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.k - b.k);
  for (const { k } of byRemainder) {
    if (left <= 0) break;
    share[k]!++;
    left--;
  }
  const next = receipt.items.slice();
  items.forEach(({ l, i }, k) => {
    next[i] = { ...l, order_discount: amountOf(share[k]! as Cents) };
  });
  return { ...receipt, items: next, lines_total: money(next.reduce((s, l) => s + lineNet(l), 0)) };
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

import type { AiFallback, ProviderErrorReason } from "@cobblr/platform-contract/scan-fallback";
import type { ReceiptReadSource } from "@cobblr/platform-contract/scan-session";
import type { RoledFacts } from "@cobblr/platform-contract";
import { amountOf, centsFromAmount, type Cents } from "@cobblr/platform-contract/money";
import { filedQuantityOf } from "./filed-quantity.js";
import type { ReceiptDateReading } from "./receipt-date.js";
import {
  detectSeller,
  parseEstimatedDelivery,
  parseReceiptTotals,
  type ReceiptTotals,
  moneyValue,
} from "@cobblr/platform-contract/receipt-totals";

export interface ParsedReceipt {
  renewal?: import("./renewal-draft.js").ReceiptRenewal;
  /** What kind of document it was, when not a store receipt. */
  document?: "bill-of-sale";
  /** A document read off a page is checked before it is believed
   *  (document-checks.ts). The fields a person should look at because a
   *  check on them did not pass, why, and whether the document model is still
   *  to read the page (it was busy). Absent when every check passed. */
  checks?: { fields: string[]; why: string[]; waiting_for_ai?: boolean; waiting_reason?: "limit" };
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
/** `ocr-form`: a scanned form read the way a form is (form-ocr.ts);
 *  `ai-document`: the page read by the document model because a check on the
 *  engine's read failed (document-read.ts); `order-page`: the lines the
 *  store's own order page gave, with no model (receipt-order-page.ts);
 *  `order-email`: a store's order confirmation email read by its layout,
 *  with no model (receipt-order-email.ts). */
export type ParseMethod = "csv" | "pdf-table" | "text-lines" | "ocr-lines" | "ocr-form" | "ai-chat" | "ai-vision" | "ai-document" | "order-page" | "order-email";

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
 *   reader_failed   the OCR engine crashed or timed out partway (OcrFailed,
 *                   #5921). Nothing was read and nothing filed; reading it
 *                   again usually works. RECOVERABLE.
 *
 * Kept as a code rather than left in the prose `reason` because the caller has
 * to decide something with it, and deciding by matching on a human sentence is
 * a string comparison waiting to be reworded.
 */
export type ReceiptFailure = "ai_unavailable" | "no_line_items" | "unreadable" | "reader_failed";

/** What was given to read, so a sentence about it names it: a PDF is never
 *  told to "check the picture". `scanned-pdf` is a PDF with no text, read
 *  from the photo of the page it carries. */
export type ReceiptSource = ReceiptReadSource;

export type ReceiptResult =
  /** `date_reading`: how the receipt's date was read (receipt-date.ts), so
   *  the session can record which way round a numeric date went (#2917). */
  | { ok: true; receipt: ParsedReceipt; method: ParseMethod; date_reading?: ReceiptDateReading; source?: ReceiptSource }
  /** `ai` / `ai_reason`: the router's coded reason when the AI was the reason
   *  (scan-fallback / provider-reason), so the session's verdict can say what
   *  to do rather than "unavailable" (#2892). `reason` stays for a person. */
  /** `hosted_job`: no AI can read it now, but the hosted identify has it
   *  queued and reads it when an engine is back (barcode-intelligence #43).
   *  Only a caller that asked to wait (`queueIfBusy`) ever gets one. */
  | { ok: false; reason: string; code: ReceiptFailure; ai?: AiFallback; ai_reason?: ProviderErrorReason; source?: ReceiptSource; hosted_job?: string };

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  // A date is not an amount. "2026-08-18" used to coerce to -20260818 (the
  // hyphen read as a sign), which is how a date cell in the wrong CSV column
  // became a price.
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(s)) return null;
  // Accounting negatives: parens, or a minus TOUCHING the number. `/-/` over
  // the whole string called "2026-08-18" negative (and then -20260818), so the
  // sign has to be adjacent, not merely present.
  const neg = /^\(.*\)$/.test(s) || /(?:^|[^\d])-\s*[\d.,]/.test(s) || /[\d][\s]*-$/.test(s);
  const n0 = moneyValue(s);
  if (n0 === null) return null;
  return neg ? -n0 : n0;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The shop's name, never a mail app's picture marker (#6702). A plain-text
 *  forward writes the store's logo as "[image: <its alt text>]" on the first
 *  line, where a receipt prints its store name, and the order was filed as
 *  bought from "[image: Example Filament Shop]". The alt text of a logo IS
 *  the shop's name, so the marker gives up its words; a marker with none
 *  names no one. */
export function vendorName(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^\[image:\s*([^\]]*)\]$/i);
  return m ? str(m[1]) : s;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A real calendar day, or null. Rejects Feb 31 instead of rolling it. */
const ymd = (y: number, m: number, d: number): string | null => {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > (days[m - 1] ?? 31)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
};

export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)!;
    return ymd(+m[1]!, +m[2]!, +m[3]!);
  }
  // Explicit formats only. The old Date.parse fallback had two faults this
  // rewrite exists for: it read a non-ISO string in SERVER-LOCAL time and then
  // converted to UTC, dating every receipt a day early east of nowhere; and it
  // read "18/08/2026" as invalid while silently flipping "03/04/2026" to
  // March 4 - a UK 3 April becomes a different purchase date with no marker.
  //
  // "12 Aug 2026" / "Aug 12, 2026" / "12 August 2026"
  let m = s.match(/\b(\d{1,2})[\s.]+([A-Za-z]{3,})\.?,?[\s.]+(\d{4})\b/);
  if (m) {
    const mo = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    if (mo) return ymd(+m[3]!, mo, +m[1]!);
  }
  m = s.match(/\b([A-Za-z]{3,})\.?[\s]+(\d{1,2})(?:st|nd|rd|th)?,?[\s]+(\d{4})\b/);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    if (mo) return ymd(+m[3]!, mo, +m[2]!);
  }
  // Numeric d/m/y or m/d/y. When one side exceeds 12 the reading is forced;
  // a genuinely ambiguous "03/04/2026" defaults to month-first (the US print
  // convention this parser has always assumed) - unchanged behaviour, but now
  // "18/08/2026" parses instead of vanishing.
  m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (m) {
    const a = +m[1]!, b = +m[2]!;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    if (a > 12 && b <= 12) return ymd(y, b, a);
    if (b > 12 && a <= 12) return ymd(y, a, b);
    return ymd(y, a, b);
  }
  return null;
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
    model?: unknown;
    weight?: unknown;
    weight_unit?: unknown;
    facts?: RoledFacts;
    manufacturer?: unknown;
    decoded?: ReceiptLine["decoded"];
    kind?: ReceiptLine["kind"];
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
      // Deliberately NOT digit-stripped: a model number is alphanumeric and
      // often hyphenated, and stripping it would leave a meaningless run of
      // digits that resolves to nothing.
      model: str(it.model)?.slice(0, 60) ?? null,
      // Only with a unit: a bare number called "weight" is a guess.
      weight: weightUnit(it.weight_unit) && (num(it.weight) ?? 0) > 0 ? num(it.weight)! : null,
      weight_unit: (num(it.weight) ?? 0) > 0 ? weightUnit(it.weight_unit) : null,
      ...(it.facts && Object.keys(it.facts).length ? { facts: it.facts } : {}),
      ...(it.decoded ? { decoded: it.decoded } : {}),
      ...(str(it.manufacturer) ? { manufacturer: str(it.manufacturer)!.slice(0, 80) } : {}),
      ...(it.kind ? { kind: it.kind } : {}),
    });
  }
  if (items.length === 0) return null;
  const currency = str(parts.currency);
  const total = num(parts.total);
  const lines_total = money(items.reduce((s, i) => s + lineNet(i), 0));
  return {
    vendor: vendorName(parts.vendor),
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

/** A line an email puts above the receipt that names no shop: its title
 *  ("Order #1001 confirmed", "Thank you for your order"), a reply or forward
 *  prefix, or a header ("From: ..."). The inbound capture puts the subject on
 *  the first line, where a till receipt prints its shop. */
export function isMailTitle(line: string): boolean {
  const s = line.trim();
  return (
    /^(?:re|fwd?|fw)\s*:/i.test(s) ||
    /^-{2,}\s*(?:forwarded|original)\s+message\b/i.test(s) ||
    /^begin\s+forwarded\s+message\b/i.test(s) ||
    /^\*?(?:from|to|cc|subject|date|sent)\*?\s*:/i.test(s) ||
    /^(?:your\s+)?order\s+(?:#\s*)?[a-z0-9-]*\d[a-z0-9-]*\s+(?:is\s+|has\s+been\s+)?(?:confirmed|received|placed|shipped|on its way|delivered|cancell?ed)\b/i.test(s) ||
    /^(?:thank\s+you|thanks)\s+for\s+(?:your\s+)?(?:order|purchase)/i.test(s) ||
    /^order\s+confirm(?:ation|ed)\b/i.test(s)
  );
}

/** The shop a forwarded email came from: the name on the "From:" line under
 *  the forward's separator ("From: Example Shop <orders@example.org>"). Only
 *  inside a forward, where that line names the original sender; the envelope's
 *  sender of a forward is the person who forwarded it. */
export function forwardedSender(text: string): string | null {
  const at = text.search(/^\s*(?:-{2,}\s*(?:forwarded|original)\s+message|begin\s+forwarded\s+message)\b/im);
  if (at < 0) return null;
  const m = text.slice(at).match(/^\s*\*?From:\*?\s*"?([^"<\n]*?)"?\s*<[^>\s]+@[^>\s]+>/im);
  const name = m?.[1]?.trim() ?? "";
  return name && /\p{L}/u.test(name) && !name.includes("@") ? name : null;
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
/**
 * A fingerprint for a receipt that prints NO order number - CSV, pdf-table and
 * text-lines can never produce one, and a till receipt has none - so the same
 * paper scanned twice used to duplicate every line, order and all.
 *
 * vendor|date|total|line-count. Null when too little was established to
 * fingerprint honestly (no date AND no total): two receipts we know that
 * little about are not provably the same one, and a false "already imported"
 * is worse than a duplicate the user can see.
 */
export function receiptContentKey(receipt: ParsedReceipt): string | null {
  const date = isoDate(receipt.date);
  const total = num(receipt.total);
  if (!date && total === null) return null;
  return [
    normalizeVendorKey(receipt.vendor),
    date ?? "",
    // MONEY-OK: a dedup key, never shown: two reads of one receipt agree to the cent.
    total === null ? "" : total.toFixed(2),
    String(receipt.items.length),
  ].join("|");
}

export function receiptDedupKey(
  vendor: string | null | undefined,
  orderRef: string | null | undefined,
): { vendor: string; orderRef: string } | null {
  const orderKey = cleanOrderRef(orderRef ?? null);
  if (!orderKey) return null;
  return { vendor: normalizeVendorKey(vendor), orderRef: orderKey };
}

/** Two spellings of one store agree when one's key begins the other's. A
 *  shipping notice names the store by its sender domain ("Amazon"); the
 *  receipt names it by its own first line ("Amazon.com", "Amazon.com, Inc.").
 *  Equal keys would call those two stores, and the order they share would be
 *  two sessions. An unknown store agrees with anything: it is the order number
 *  that identifies the order, the store only tells two stores' numbers apart. */
export function vendorsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = normalizeVendorKey(a);
  const kb = normalizeVendorKey(b);
  if (!ka || !kb || ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 4 && long.startsWith(short);
}

/** An order number long enough to be its own identity, whatever the store
 *  reads as: Amazon's 3-7-7, a Shopify "#1001-A" is not. Ten characters with
 *  a digit, since a short number ("#4271") recurs across every small shop. */
export function isStrongOrderRef(orderRef: string | null | undefined): boolean {
  const r = (orderRef ?? "").trim();
  return r.length >= 10 && /\d/.test(r);
}

/** Of the sessions that carry this order number, the one this email is about:
 *  the newest whose store agrees, else the newest at all when the number alone
 *  is strong enough to say. Rows arrive newest first. */
export function sameOrder<T extends { vendor: string | null }>(
  rows: T[],
  vendor: string | null | undefined,
  orderRef: string | null | undefined,
): T | undefined {
  return rows.find((r) => vendorsAgree(r.vendor, vendor)) ?? (isStrongOrderRef(orderRef) ? rows[0] : undefined);
}

/** Whether a cancellation ends a session that is still waiting for its receipt.
 *
 *  A session opened from "Ordered: 1 Electronics item" holds nothing but the
 *  promise of a parcel; when the store then says the item is cancelled, the
 *  promise is withdrawn and the session would sit on the page awaiting a
 *  receipt that will never come. It ends when nothing has shipped (a parcel in
 *  transit is still coming, whatever else was cancelled) and the order was a
 *  single item, or its size is unknown: a "3 items" order with one cancelled
 *  still has two on the way. */
export function cancellationEndsSession(session: { shipment_state: string | null; shipment_description: string | null }): boolean {
  if (session.shipment_state) return false;
  const m = /^(?:fwd?:\s*)?ordered:\s*(\d+)\b/i.exec(session.shipment_description ?? "");
  return !m || Number(m[1]) <= 1;
}
