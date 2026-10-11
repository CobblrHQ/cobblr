// What a label says about the item it is stuck on, read from its text with no
// model (#3729, #3731): how many, which lot, which colourway, the SKU, and a
// case code. The text is the OCR engine's (services/ocr.ts), or the photo
// read's transcription when there is no engine.
//
// The owner scanned a skein's own barcode and then photographed the bulk bag's
// sticker, meaning "this is the item, and I have three of them". The sticker
// said so: quantity contained 3, lot 6127, colour J7 dark blue, SKU 10133752,
// and a GTIN-14 case code. None of it reached the item.

import { labelCountOf } from "./label-count.js";
import { gtinItem } from "./identifier-equals.js";

export interface LabelFacts {
  quantity?: number;
  /** The batch printed on this unit (a dye lot, a food lot, a filament
   *  batch). Lands in whichever field of the destination carries the `lot`
   *  role; per unit, so never a fact about the product. */
  lot?: string;
  /** The year printed on this unit (a vintage). Per unit like the lot: lands
   *  in the field carrying the `year-made` role, never sent as a product fact. */
  year_made?: string;
  colorway?: string;
  sku?: string;
  /** A GTIN-14 case code (packaging indicator 1 to 8), kept as the pack's
   *  code; its inner item code is the item's (identifier-equals.ts). */
  pack_code?: string;
}

const LOT = /\b(?:dye\s*)?(?:lot|batch)\s*(?:no\.?|number|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{1,11})\b/gi;
const COLOUR = /\b(?:colou?r(?:way)?|shade)\s*(?:code|name)?\s*[:.]?\s*([A-Z0-9][A-Za-z0-9 ]{1,28}?)(?=\s*(?:\/|,|\.|;|\n|$|\band\b|\blot\b|\bsku\b|\bqty\b|\bquantity\b|\d{4,}))/i;
const SKU = /\bSKU\s*(?:no\.?|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{3,19})\b/i;
const CODE14 = /\b(\d{14})\b/g;
// Only a year a word introduces: a bare four-digit number on a label is as
// often a phone prefix, a street number or "since 1887" as it is a vintage.
const YEAR_MADE = /\b(?:vintage|millésime|millesime|cosecha|añada|jahrgang|annata|vendemmia|colheita|harvest(?:ed)?)\s*[:.]?\s*((?:1[89]|20)\d{2})\b/i;

/** A year a unit could have been made in, as four digits, or null: from 1800
 *  to next year (a wine is bottled the year after its harvest at the earliest,
 *  and a label dated further ahead is a misread). */
export function yearMadeOf(v: unknown, now: Date = new Date()): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return y >= 1800 && y <= now.getUTCFullYear() + 1 ? s : null;
}

/** The label's facts, from its text. Pure; only what is printed. */
export function labelFactsOf(text: string | null | undefined): LabelFacts {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return {};
  const out: LabelFacts = {};
  const n = labelCountOf(t);
  if (n) out.quantity = n;
  // The first "lot" followed by a value with a digit in it: a label that says
  // "DYE LOT / TEINTURE" before its number is not answered with the next word.
  for (const m of t.matchAll(LOT)) {
    if (/\d/.test(m[1]!)) {
      out.lot = m[1]!;
      break;
    }
  }
  const year = yearMadeOf(YEAR_MADE.exec(t)?.[1]);
  if (year) out.year_made = year;
  const colour = COLOUR.exec(t)?.[1]?.trim();
  if (colour && /[a-z]/i.test(colour)) out.colorway = colour.replace(/\b([A-Za-z])([A-Za-z]*)\b/g, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
  const sku = SKU.exec(t)?.[1];
  if (sku) out.sku = sku;
  for (const m of t.matchAll(CODE14)) {
    const c = m[1]!;
    if (c[0] !== "0" && c[0] !== "9" && gtinItem(c)) {
      out.pack_code = c;
      break;
    }
  }
  return out;
}
