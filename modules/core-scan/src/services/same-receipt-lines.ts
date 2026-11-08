// One product a receipt printed on two lines is one row (#9268). A till prints
// each scan of the same peppers as its own line, and the inbox asked about them
// twice. Same code, or the same words when there is no code, at the same unit
// price: anything else is kept apart, because a merge that was wrong costs more
// than a second row. One rule for a receipt being read and for rows already
// made (heal-same-receipt-lines.ts). Pure.

import { amountOf, centsFromAmount, type Cents } from "@cobblr/platform-contract/money";
import { lineImagesFor, type EmailLineImage } from "@cobblr/platform-contract/email-line-images";
import { lineQuantity, type ParsedReceipt, type ReceiptLine, type SourceLine } from "./receipt-shared.js";

const words = (s: unknown): string => (typeof s === "string" ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");
const money = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface LineIdentity {
  code: string | null;
  description: string | null;
  model?: unknown;
  manufacturer?: unknown;
  unitPrice: unknown;
  lineTotal: unknown;
  quantity: number;
  /** Sold by weight, or a thing with its own identity: never the same as
   *  another line, whatever it is called. */
  oneOfItsOwn: boolean;
}

/** What two lines must share to be one product, or null for a line that is
 *  never merged. A line with no price to compare is not known to be the same. */
export function sameProductKey(l: LineIdentity): string | null {
  if (l.oneOfItsOwn) return null;
  const who = l.code ? `code:${l.code}` : words(l.description) ? `name:${words(l.description)}` : null;
  if (!who) return null;
  const total = money(l.lineTotal);
  const each = money(l.unitPrice) ?? (total !== null && l.quantity > 0 ? total / l.quantity : null);
  if (each === null) return null;
  return JSON.stringify([who, words(l.model), words(l.manufacturer), centsFromAmount(each)]);
}

const lineKey = (l: ReceiptLine): string | null =>
  sameProductKey({
    code: l.code,
    description: l.description,
    model: l.model,
    manufacturer: l.manufacturer,
    unitPrice: l.unit_price,
    lineTotal: l.line_total,
    quantity: lineQuantity(l),
    oneOfItsOwn: !!l.kind || !!l.facts || !!l.decoded || (l.weight !== null && l.weight !== undefined && l.weight > 0),
  });

/** Two amounts added to the cent. Null only when neither was read. */
export function addAmounts(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return amountOf((centsFromAmount(a) + centsFromAmount(b)) as Cents);
}

const sourceOf = (l: ReceiptLine): SourceLine => ({
  qty: l.qty,
  line_total: l.line_total,
  discount: l.discount,
  order_discount: l.order_discount ?? null,
});

/**
 * The receipt with one line per product, each merged line keeping the lines it
 * came from (`source_lines`). Its rows and its purchase are both made from this,
 * so they agree. `photos[i]` is the picture the receipt printed beside line i:
 * two lines with different pictures are two variants that read alike. A bill of
 * sale is about one thing and is left as printed.
 */
export function withSameLinesCombined(receipt: ParsedReceipt, photos: ReadonlyArray<unknown> = []): ParsedReceipt {
  if (receipt.document) return receipt;
  const out: ReceiptLine[] = [];
  const pictureOf: unknown[] = [];
  const atKey = new Map<string, number[]>();
  for (const [i, line] of receipt.items.entries()) {
    const key = lineKey(line);
    const photo = photos[i] ?? null;
    const at = key ? atKey.get(key)?.find((n) => !photo || !pictureOf[n] || JSON.stringify(pictureOf[n]) === JSON.stringify(photo)) : undefined;
    if (at === undefined) {
      if (key) atKey.set(key, [...(atKey.get(key) ?? []), out.length]);
      out.push(line);
      pictureOf.push(photo);
      continue;
    }
    const kept = out[at]!;
    pictureOf[at] = pictureOf[at] ?? photo;
    out[at] = {
      ...kept,
      qty: lineQuantity(kept) + lineQuantity(line),
      line_total: kept.line_total === null || line.line_total === null ? null : addAmounts(kept.line_total, line.line_total),
      discount: addAmounts(kept.discount, line.discount),
      order_discount: addAmounts(kept.order_discount, line.order_discount),
      source_lines: [...(kept.source_lines ?? [sourceOf(kept)]), sourceOf(line)],
    };
  }
  return out.length === receipt.items.length ? receipt : { ...receipt, items: out };
}

/** The receipt as its rows and its purchase are made from: the same product at
 *  the same price is one line, whichever door brought it in (#9268). */
export function oneLinePerProduct(receipt: ParsedReceipt, lineImages: readonly EmailLineImage[] | null): ParsedReceipt {
  return withSameLinesCombined(receipt, lineImagesFor(receipt.items.map((l) => (l.kind ? "" : l.description)), lineImages ?? []));
}
