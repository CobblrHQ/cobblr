// Is this text the text of a receipt? Decided from its STRUCTURE, before any
// model is asked what the picture shows.
//
// Two of the review pack's three receipts went through the general upload
// door with a verified image model and did not become receipt sessions: a
// sparse one read as nothing at all, a receipt with one dominant product
// line read as that product (#2916). The is-receipt verdict rode the identify
// step's free-form answer, and a model asked "what item is this" answers with
// an item. A receipt is not an item; it is a document with a shape, and the
// shape is readable without a model: several short lines each ending in a
// price, a totals row, a store header, a date. The receipt parser's own line
// pass already reads exactly those (receipt-text.ts). This scores them.
//
// What the score reads, and what it deliberately does not:
//   • priced lines: the line parser's own rule, a label then a cents amount
//     at the END of the line. Product labels, listings and menus have prices
//     too, so a priced line alone is a weak signal.
//   • a totals row (subtotal / total / amount due): the strongest single
//     signal. A menu prints prices and no total; a listing prints one price.
//   • bookkeeping rows (tax, cash, change, a card name): the document's
//     furniture, from the parser's own STRUCTURAL vocabulary.
//   • a date, a store header, a quantity-times-unit-price line: each worth a
//     little, none decisive.
//   • NOT whole-frame image statistics. Measured and recorded as a dead end
//     in docs/design-decisions/receipt-from-a-photo.md §4: the background of a
//     real photo dominates them.
//
// Three verdicts, because the model gets a say in the middle:
//   receipt  → route to receipt review; identify is never asked
//   maybe    → identify runs; its own structured is_receipt answer decides,
//              and an "unsure" from it lands on the receipt side
//   not      → identify runs as it always did
//
// Thresholds were set on the corpus in modules/core-scan/tests/fixtures/
// receipt-shape/ (the pack's three receipts and eight photos through the
// real OCR engine, plus the OCR benchmark's eight store archetypes at clean
// and camera quality) and are asserted by tests/receipt-shape-check.test.ts;
// change one, re-run that test.

import { ENDS_ITEMS, NOISE, QTY_AT, STRUCTURAL, detectDate, detectVendor, readTrailingAmount } from "./receipt-text.js";

export type ReceiptShapeVerdict = "receipt" | "maybe" | "not";

export interface ReceiptShapeSignals {
  /** Non-blank lines the text had. */
  lines: number;
  /** Lines carrying a label and a cents amount at the end, less the totals
   *  and bookkeeping rows: the lines that would become items. */
  priced_items: number;
  /** A subtotal / total / amount-due row was present. */
  totals_row: boolean;
  /** Bookkeeping rows: tax, cash, change, a card, a coupon. */
  structural_rows: number;
  /** A date in one of the forms a till prints. */
  date: boolean;
  /** A store name at the top, by the parser's own rule. */
  vendor: boolean;
  /** A "2 @ 3.49" quantity-times-unit-price line. */
  qty_at: boolean;
}

export interface ReceiptShape {
  verdict: ReceiptShapeVerdict;
  /** 0..1, the weighted sum below; the verdict is a threshold on it. */
  score: number;
  signals: ReceiptShapeSignals;
}

/** A totals row that would end the parser's item region, in every spelling
 *  the parser accepts, plus the grand-total forms. */
const TOTALS = ENDS_ITEMS;

export const RECEIPT_THRESHOLD = 0.6;
export const MAYBE_THRESHOLD = 0.3;

export function receiptShapeSignals(text: string): ReceiptShapeSignals {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  let pricedItems = 0;
  let totalsRow = false;
  let structuralRows = 0;
  let qtyAt = false;
  for (const line of lines) {
    if (QTY_AT.test(line)) qtyAt = true;
    const hit = readTrailingAmount(line);
    if (!hit) continue;
    if (TOTALS.test(hit.label)) {
      totalsRow = true;
      continue;
    }
    if (STRUCTURAL.test(hit.label) || hit.amount < 0) {
      structuralRows += 1;
      continue;
    }
    // The parser wants letters in a description; a bare "1.18" on a line of
    // its own is an amount that lost its label to OCR, not an item. The one
    // exception is the parser's own: "12 @ 3.98   47.76" under a description
    // printed on the line above, which a contractor desk does for every item.
    if (!/[a-z]/i.test(hit.label) && !QTY_AT.test(hit.label)) continue;
    pricedItems += 1;
  }
  return {
    lines: lines.length,
    priced_items: pricedItems,
    totals_row: totalsRow,
    structural_rows: structuralRows,
    date: detectDate(text) !== null,
    vendor: detectVendor(lines) !== null,
    qty_at: qtyAt,
  };
}

export function scoreReceiptShape(text: string): ReceiptShape {
  const s = receiptShapeSignals(text);
  let score = 0;
  // Two priced lines is where "a label with a price on it" stops explaining
  // the text; three is a list.
  if (s.priced_items >= 3) score += 0.4;
  else if (s.priced_items === 2) score += 0.3;
  else if (s.priced_items === 1) score += 0.1;
  if (s.totals_row) score += 0.3;
  if (s.structural_rows >= 1) score += 0.1;
  if (s.date) score += 0.05;
  if (s.vendor) score += 0.05;
  if (s.qty_at) score += 0.05;
  // One price and a total is a listing or a cart page with a single line on
  // it, and a listing is a scan of that item (the identify prompt says so).
  // Two prices and a total is a receipt however short.
  if (s.priced_items < 2) score = Math.min(score, RECEIPT_THRESHOLD - 0.05);
  score = Math.round(Math.min(1, score) * 100) / 100;
  const verdict: ReceiptShapeVerdict = score >= RECEIPT_THRESHOLD ? "receipt" : score >= MAYBE_THRESHOLD ? "maybe" : "not";
  return { verdict, score, signals: s };
}

/** The empty shape, for an image with no readable text (a product photo, a
 *  deployment with no OCR engine): "not", and every signal off. */
export function noReceiptShape(): ReceiptShape {
  return scoreReceiptShape("");
}
