// VOCAB-ENUMERATION OK: this is an EXTRACTOR for one kind of document, and
// naming what a bill of sale prints (VIN, odometer, buyer, seller) is its whole
// job. What it returns is keyed by field ROLE, so nothing downstream learns any
// of these words.
//
// A bill of sale records a private sale: one thing, one price, a buyer and a
// seller, and for a vehicle its VIN, year, make, model and odometer. It is not
// a store receipt and has no line items to reconcile, so the till-receipt
// parser rightly found nothing in one and the read failed (#4523). Read
// heuristically first (heuristic first, AI last): the labels on these forms
// are few and printed plainly. The thing it records becomes ONE inbox item
// with its purchase. Its facts ride the line by field role (acquired-for,
// acquired-on, seller, acquired-from, year-made, usage), and a VIN rides as a
// VIN decode (the code, year, make, model), so filing it fills the record's
// own fields by meaning, through the same doors a scan uses.

import { checkDigitValid } from "./vin-decode.js";
import type { RoledFacts } from "@cobblr/platform-contract";
import { buildReceipt, type ParsedReceipt } from "./receipt-shared.js";
import { moneyValue } from "@cobblr/platform-contract/receipt-totals";
import { lineKind, NOT_A_LINE, UNIT_LINE } from "./charge-lines.js";
import { detectVendor } from "./receipt-text.js";
import type { DocumentFigures } from "./document-checks.js";

/** A form's own title, never the name of whoever sold it. */
const TITLE = /\b(?:bill\s+of\s+sale|buyer'?s\s+order|retail\s+(?:purchase\s+)?order|purchase\s+agreement|purchase\s+contract|invoice)\b/i;

/** What a model may call a sale document when asked what a page is: the
 *  prompt offers bill-of-sale, invoice, receipt and other, and models answer in
 *  their own words besides (a "retail order", an "order", a "purchase
 *  agreement"). They are one family: the record of a sale, read by the same
 *  reader. A sale form a model called an "invoice" was dropped whole while
 *  every field on it had been read right (#4571, #4628). */
const SALE_DOCUMENT_LABEL = /^(?:bill[\s_-]*of[\s_-]*sale|invoice|(?:sales?[\s_-]*)?receipt|(?:retail[\s_-]*|sales?[\s_-]*|purchase[\s_-]*|buyer'?s?[\s_-]*)?order|(?:retail[\s_-]*)?purchase[\s_-]*(?:agreement|contract)|sale|other)$/i;

/** Is this what a model called a page of the sale-document family? A page a
 *  model would not name at all is read as one too (the prompt asked about a
 *  sale document); a page it named as something else (a manual) is not. */
export function isSaleDocumentLabel(label: string | null | undefined): boolean {
  const l = String(label ?? "").trim();
  return !l || SALE_DOCUMENT_LABEL.test(l);
}

/** Does this text read as a bill of sale (or a private-sale agreement)? */
export function looksLikeBillOfSale(text: string): boolean {
  if (/\bbill\s+of\s+sale\b/i.test(text)) return true;
  // A dealer's names for the same paper; a dealer's "Retail Order" is the
  // carbon-copy form many sell on (#4571).
  if (/\b(?:buyer'?s\s+order|retail\s+(?:purchase\s+)?order|(?:retail\s+)?purchase\s+agreement|vehicle\s+purchase\s+contract)\b/i.test(text)) return true;
  // A sale between two people names both and a price, and a till receipt
  // never prints "buyer".
  return /\bbuyer\b/i.test(text) && /\bseller\b/i.test(text) && /\b(?:purchase|sale|selling|sales)\s+price\b/i.test(text);
}

/** Does this text record a sale at all: a bill of sale, or the words a
 *  receipt or invoice prints around money? Asked before a model is, for a
 *  document put on a record, which is as often a manual as a receipt. */
export function looksLikeTransaction(text: string): boolean {
  if (looksLikeBillOfSale(text)) return true;
  const money = (text.match(/\$\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\b/g) ?? []).length;
  const words = /\b(?:total|subtotal|amount\s+(?:due|paid)|paid|price|invoice|receipt|order\s+(?:#|no|number)|qty|balance\s+due|sold\s+(?:to|by))\b/i.test(text);
  return words && money >= 1;
}

/** The value printed after a label, on the same line ("Make: Honda"), or on
 *  the next one when the label stands alone (a form's printed caption). */
function labelled(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = label.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length).replace(/^[\s:#.\-_]+/, "").trim();
    // Stop at the next label on the same line ("Make: Honda   Model: Civic").
    const own = rest.split(/\s{2,}|\s+(?=(?:year|make|model|vin|color|colour|body|odometer|mileage|date|price|seller|buyer|signature)\b\s*[:#])/i)[0]?.trim() ?? "";
    if (own) return own;
    const next = lines[i + 1]?.trim();
    if (next && !/:/.test(next)) return next;
  }
  return null;
}

const VIN = /\b([A-HJ-NPR-Z0-9]{17})\b/;

/** The VIN AS PRINTED: seventeen characters with no I, O or Q, preferring
 *  one printed beside a VIN label. OCR reads an O for a 0, so that one
 *  confusion is put right. Not proved: only the checks read this (they try a
 *  look-alike swap against the vehicle database); everything else takes
 *  readVin. */
export function readVinAsPrinted(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const near = labelled(lines, /\b(?:VIN|vehicle\s+identification\s+(?:number|no\.?))\b/i);
  const candidates = [near, text].filter((s): s is string => !!s);
  for (const c of candidates) {
    const upper = c.toUpperCase().replace(/[\s-]/g, (ch) => (ch === "-" ? "" : " "));
    const fixed = upper.replace(/\b[A-Z0-9]{17}\b/g, (w) => (/[IOQ]/.test(w) && /\d/.test(w) ? w.replace(/O|Q/g, "0").replace(/I/g, "1") : w));
    const m = VIN.exec(fixed);
    if (m && /\d/.test(m[1]!) && /[A-Z]/.test(m[1]!)) return m[1]!;
  }
  return null;
}

/** The VIN, only when it passes its check digit (ISO 3779's ninth
 *  character, as North America requires it). A VIN that fails names no
 *  vehicle, is decoded to nothing and is matched to nothing: CI's misread
 *  form became "2014 HONDA WATCU 4" from the words printed beside one
 *  (#5921). */
export function readVin(text: string): string | null {
  const printed = readVinAsPrinted(text);
  return printed && checkDigitValid(printed) ? printed : null;
}

/** A sale date as ISO, from a labelled date on the form. */
function isoFrom(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    // A US form: month first.
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  const d = Date.parse(t.replace(/(\d)(st|nd|rd|th)\b/, "$1"));
  if (Number.isFinite(d)) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  return null;
}

/** A person's name as printed, without a signature line's leftovers. */
function personName(s: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/_{2,}.*/, "").replace(/\b(?:signature|date|address|phone)\b.*$/i, "").replace(/[,;:]+$/, "").trim();
  if (!t || t.length > 60 || /\d{3,}/.test(t)) return null;
  // A signature line's caption ("Dealer or authorized representative") is
  // where a name is signed, not a name.
  if (/^(?:or\b|and\b)|\b(?:authori[sz]ed|representative|printed\s+name|print\s+name)\b/i.test(t)) return null;
  return t;
}

/** What a sale document says about the thing sold, when it prints it. */
export interface SoldThing {
  year: number | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  odometer: number | null;
}

/** The vehicle (or any titled thing) a sale document describes. */
export function readSoldThing(text: string): SoldThing {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " "));
  const yearText = labelled(lines, /\b(?:model\s+)?year\b/i);
  const year = yearText ? /\b(19[5-9]\d|20\d{2})\b/.exec(yearText)?.[1] : undefined;
  const make = labelled(lines, /\bmake\b/i);
  const model = labelled(lines, /\bmodel\b(?!\s+year)/i);
  const odoText = labelled(lines, /\b(?:odometer(?:\s+reading)?|mileage)\b/i);
  const odometer = odoText ? Number((/[\d,]{1,9}/.exec(odoText)?.[0] ?? "").replace(/,/g, "")) : NaN;
  return {
    year: year ? Number(year) : null,
    make: make?.slice(0, 40) ?? null,
    model: model?.slice(0, 60) ?? null,
    vin: readVin(text),
    odometer: Number.isFinite(odometer) && odometer > 0 ? odometer : null,
  };
}

/** The sold thing's name, as the form prints it (year make model). */
function soldName(t: SoldThing): string | null {
  const name = [t.year, t.make, t.model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return name || (t.vin ? `Vehicle ${t.vin}` : null);
}

/** The unit line: the thing itself, with its facts, ready for filing. */
function unitLine(thing: SoldThing, price: number, date: string | null, seller: string | null, fallbackName: string) {
  const facts: RoledFacts = { "acquired-for": price };
  if (date) facts["acquired-on"] = date;
  if (seller) {
    facts.seller = seller;
    facts["acquired-from"] = seller;
  }
  if (thing.year) facts["year-made"] = thing.year;
  if (thing.odometer) facts.usage = thing.odometer;
  return {
    description: soldName(thing) ?? fallbackName,
    qty: 1,
    unit_price: price,
    line_total: price,
    facts,
    manufacturer: thing.make,
    model: thing.model,
    // The VIN, and what the form says it is, as a VIN decode would give
    // them: the vehicle's own fields declare decode roles (identifier:vin,
    // decode:year, decode:make, decode:model), so they fill exactly as a
    // scanned VIN fills them. A role-tagged `identifier` is not used: on a
    // vehicle that is the plate.
    ...(thing.vin
      ? {
          decoded: {
            decoder_id: "vin",
            code: thing.vin,
            fields: {
              vin: thing.vin,
              ...(thing.year ? { year: thing.year } : {}),
              ...(thing.make ? { make: thing.make } : {}),
              ...(thing.model ? { model: thing.model } : {}),
            },
          },
        }
      : {}),
  };
}

/** A sale form's sums that NOT_A_LINE (shared with every receipt) does not
 *  name: the taxable amount, and money put down. A grocery receipt's bottle
 *  deposit is a charge, so "deposit" belongs here and not there. */
export const FORM_SUM = /\b(?:taxable(?:\s+amount)?|deposit|amount\s+(?:taxable|subject\s+to\s+tax))\b/i;

/** The money a sale form prints beside its lines, for the checks
 *  (document-checks.ts): the taxable amount, the total, the deposit and the
 *  balance on delivery. */
export function readDocumentFigures(text: string): DocumentFigures {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " "));
  const amount = (label: RegExp): number | null => {
    for (const line of lines) {
      const m = label.exec(line);
      if (!m) continue;
      const after = line.slice(m.index + m[0].length);
      const v = /\$?\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/.exec(after);
      if (v) return moneyValue(v[1]!);
    }
    return null;
  };
  return {
    taxable: amount(/\btaxable(?:\s+amount)?\b/i),
    total: amount(/^\s*(?:total(?:\s+(?:sale\s+)?price)?|grand\s+total|total\s+due)\b/i),
    deposit: amount(/\bdeposit\b/i),
    balance: amount(/\bbalance(?:\s+(?:on|due\s+on)\s+delivery|\s+due)?\b/i),
  };
}

/** Every other priced line of an itemized sale form ("Documentary Fee ...
 *  175.00"), the unit and the sums left out. */
function itemizedLines(lines: string[]): Array<{ description: string; amount: number }> {
  const out: Array<{ description: string; amount: number }> = [];
  for (const raw of lines) {
    const m = /^\s*(.*?[A-Za-z].*?)[\s.:_$-]+\$?\s?(-?[\d,]+\.\d{2})\s*$/.exec(raw);
    if (!m) continue;
    const description = m[1]!.replace(/[\s.:_-]+$/, "").trim();
    if (!description || UNIT_LINE.test(description) || NOT_A_LINE.test(description) || FORM_SUM.test(description)) continue;
    const amount = moneyValue(m[2]!);
    if (amount === null || amount === 0) continue;
    out.push({ description: description.slice(0, 120), amount });
  }
  return out;
}

/**
 * Read a bill of sale from its text, or null when it is not one or names no
 * price. A private sale gives one line; a dealer's itemized form gives the
 * unit line first and every fee, tax and add-on after it, marked so they stay
 * lines on the purchase and never become inbox items. Never guesses: a field
 * the form does not print is absent.
 */
export function readBillOfSale(text: string): ParsedReceipt | null {
  if (!looksLikeBillOfSale(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, " "));

  const priceText =
    labelled(lines, UNIT_LINE) ??
    labelled(lines, /\b(?:amount\s+paid|total\s+price|price\s+paid|consideration)\b/i) ??
    /\bsum\s+of\s+(\$\s?[\d,]+(?:\.\d{2})?)/i.exec(text)?.[1] ??
    null;
  const price = priceText ? moneyValue(/\$?\s?[\d,]+(?:\.\d{2})?/.exec(priceText)?.[0] ?? "") : null;
  if (price === null || price <= 0) return null;

  const thing = readSoldThing(text);
  // The labelled date; failing that, the first full date in the form's head,
  // which on a sale form is the day of the sale (a scan's small "DATE"
  // caption is the first thing a faint copy loses, its value is not).
  const date =
    isoFrom(labelled(lines, /\b(?:date\s+of\s+sale|sale\s+date|date\s+sold|dated?)\b/i)) ??
    isoFrom(lines.slice(0, 30).map((l) => /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.exec(l)?.[0]).find(Boolean) ?? null);
  const seller = personName(labelled(lines, /\b(?:seller|dealer)(?:'s)?(?:\s+(?:printed\s+)?name)?\b/i));
  const others = itemizedLines(lines).map((l) => ({
    description: l.description,
    qty: 1,
    unit_price: l.amount,
    line_total: l.amount,
    kind: lineKind(l.description) === "charge" ? ("charge" as const) : ("add-on" as const),
  }));
  const totalText = labelled(lines, /\b(?:total\s+(?:sale\s+)?price|grand\s+total|total\s+due|total)\b/i);
  const printedTotal = totalText ? moneyValue(/\$?\s?[\d,]+(?:\.\d{2})?/.exec(totalText)?.[0] ?? "") : null;

  // A dealer's itemized form is headed by the dealer, the way a till receipt
  // is headed by the shop; a private sale's form is headed by its title, and
  // a person's sale names no shop.
  // A "Label: value" line (a form read's settled field) names a field, never
  // the dealer.
  const dealer = !seller && others.length > 0 ? detectVendor(lines.filter((l) => !TITLE.test(l) && !/^[A-Za-z][A-Za-z ]{1,24}:\s/.test(l))) : null;

  const receipt = buildReceipt({
    vendor: dealer,
    seller,
    date,
    total: printedTotal ?? price + others.reduce((s, o) => s + o.line_total, 0),
    items: [unitLine(thing, price, date, seller ?? dealer, "Item on the bill of sale"), ...others],
  });
  return receipt ? { ...receipt, document: "bill-of-sale" } : null;
}

/**
 * Make a receipt read some other way (a model looking at the page, the till
 * parser) into a bill of sale when it is one: the unit is the one thing, named
 * from the form, and every other line is a charge or an add-on that stays on
 * the purchase. A receipt with no unit line and no bill-of-sale text is left
 * as it was.
 */
export function asBillOfSale(receipt: ParsedReceipt, text: string | null): ParsedReceipt {
  if (receipt.document) return receipt;
  const unitAt = receipt.items.findIndex((l) => UNIT_LINE.test(l.description));
  const isSale = (text ? looksLikeBillOfSale(text) : false) || unitAt >= 0;
  if (!isSale) return receipt;
  // The unit: the line that says so, else the dearest line that is not a charge.
  let at = unitAt;
  if (at < 0) {
    let best = -1;
    receipt.items.forEach((l, i) => {
      if (lineKind(l.description) === "charge") return;
      if (best < 0 || (l.line_total ?? 0) > (receipt.items[best]!.line_total ?? 0)) best = i;
    });
    at = best;
  }
  if (at < 0) return receipt;
  const unit = receipt.items[at]!;
  const price = unit.line_total ?? unit.unit_price ?? 0;
  const thing = text ? readSoldThing(text) : { year: null, make: null, model: null, vin: null, odometer: null };
  const sellerName = receipt.seller ?? receipt.vendor;
  const made = unitLine(thing, price, receipt.date, sellerName, UNIT_LINE.test(unit.description) ? "Item on the bill of sale" : unit.description);
  const items = [
    { ...unit, ...made, code: unit.code, weight: null, weight_unit: null, discount: unit.discount },
    ...receipt.items
      .filter((_, i) => i !== at)
      .map((l) => ({ ...l, kind: lineKind(l.description) === "charge" ? ("charge" as const) : ("add-on" as const) })),
  ];
  return { ...receipt, document: "bill-of-sale", items };
}

/** Mark every charge line of any receipt: a fee, a tax, a delivery charge is
 *  a line on the purchase, never an inbox item. */
export function markCharges(receipt: ParsedReceipt): ParsedReceipt {
  let changed = false;
  const items = receipt.items.map((l) => {
    if (l.kind || lineKind(l.description) !== "charge") return l;
    changed = true;
    return { ...l, kind: "charge" as const };
  });
  return changed ? { ...receipt, items } : receipt;
}
