// A receipt line that is several of a thing, read off its own words (#5350).
//
// A Kingroon order listed "KINGROON PETG Filament 1.75mm - US / 10KG / white"
// and two multicolour siblings. Each is ten 1 kg spools (the email's photo
// shows ten), and the model read them three ways: a 10 kg spool, a 2 kg
// spool and no size at all. The words settle it before any model is asked:
// a bundle, a mix or a count word says "several", and lines of one product
// that differ only by variant are read together, so siblings never disagree.
// When nothing settles it the card asks once ("10 spools of 1 kg, or one
// 10 kg spool?") rather than guessing per line.

import { countOf, quantityWithUnit } from "@cobblr/platform-contract/plural";

export interface LinePack {
  /** How many come on the line (per unit the line sold). */
  count: number;
  /** One of them, in a field's words ("1 kg"). */
  each: string;
  /** The line's whole amount, as one thing ("10 kg"). */
  whole: string;
  /** A mixed pack's colour ("Mixed (10 colours)"); null for one colour. */
  colour: string | null;
  /** Nothing on the line settles it: ask "count of each, or one whole?". */
  ask: boolean;
}

const UNITS: Record<string, { unit: string; kg: number }> = {
  kg: { unit: "kg", kg: 1 },
  kgs: { unit: "kg", kg: 1 },
  g: { unit: "g", kg: 0.001 },
  lb: { unit: "lb", kg: 0.4536 },
  lbs: { unit: "lb", kg: 0.4536 },
};

const AMOUNT = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*(kgs?|lbs?|g)\b/i;
const EXPLICIT = /(?:^|[^a-z0-9.])(\d{1,3})\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kgs?|lbs?|g)\b/i;
const COUNT_WORD = /(?:^|[^a-z0-9.])(\d{1,3})\s*-?\s*(?:pack|pk|pcs|pieces|rolls|spools|count|ct)\b/i;
const BUNDLE = /\b(bundle|bulk|multi-?colou?rs?|mixed|rainbow|assorted|variety|combo)\b/i;
const MIX = /\b(multi-?colou?rs?|mixed|rainbow|assorted|variety)\b/i;
/** The lines whose usual unit is known: filament comes on 1 kg spools. */
const FILAMENT = /\bfilament\b/i;
/** The largest filament spool sold as one, on the choice lists that ship. A
 *  larger amount with no word saying "several" is the one worth asking. */
const SINGLE_SPOOL_MAX_KG = 5;

const n = (s: string): number => Number(s);
const amountWords = (amount: number, unit: string): string =>
  quantityWithUnit(amount, unit, { symbol: unit, name: unit, plural: unit, category: "mass" });

function mixOf(text: string, count: number): string | null {
  return MIX.test(text) ? `Mixed (${countOf(count, "colour")})` : null;
}

/** One line, alone: what its own words say. */
export function readLinePack(description: string): LinePack | null {
  const text = description ?? "";
  const explicit = text.match(EXPLICIT);
  if (explicit) {
    const count = n(explicit[1]!);
    const u = UNITS[explicit[3]!.toLowerCase()]!;
    const each = n(explicit[2]!);
    if (count >= 2) return { count, each: amountWords(each, u.unit), whole: amountWords(each * count, u.unit), colour: mixOf(text, count), ask: false };
  }
  const amount = text.match(AMOUNT);
  if (!amount || !FILAMENT.test(text)) return null;
  const u = UNITS[amount[2]!.toLowerCase()]!;
  const whole = n(amount[1]!);
  const kg = whole * u.kg;
  const counted = text.match(COUNT_WORD);
  if (counted) {
    const count = n(counted[1]!);
    if (count >= 2) return { count, each: amountWords(whole / count, u.unit), whole: amountWords(whole, u.unit), colour: mixOf(text, count), ask: false };
  }
  // A kilogram or less is one spool; a weight that is not whole kilograms
  // is not a count of 1 kg spools.
  if (u.unit !== "kg" || kg <= 1 || !Number.isInteger(kg)) return null;
  const pack = { count: kg, each: "1 kg", whole: amountWords(whole, u.unit), colour: mixOf(text, kg) };
  if (BUNDLE.test(text)) return { ...pack, ask: false };
  return kg > SINGLE_SPOOL_MAX_KG ? { ...pack, ask: true } : null;
}

/** The product a line is, without its variant: "KINGROON PETG Filament
 *  1.75mm - US / 10KG / white" is "kingroon petg filament 1.75mm". */
function productOf(description: string): string {
  return (description.split(/\s[-–|]\s|\s\/\s/)[0] ?? "").trim().toLowerCase();
}

function amountOf(description: string): string | null {
  const m = description.match(AMOUNT);
  return m ? `${n(m[1]!)}${UNITS[m[2]!.toLowerCase()]!.unit}` : null;
}

/** Every line of one order, read together: lines of one product with the
 *  same amount that differ only by variant are packs of the same shape, so
 *  one sibling's "bundle" or "multicolor" settles the white one too, and
 *  an unsettled set asks the same question on every line. */
export function readOrderPacks(descriptions: readonly string[]): Array<LinePack | null> {
  const alone = descriptions.map(readLinePack);
  const key = (d: string) => {
    const amount = amountOf(d);
    return amount ? `${productOf(d)}|${amount}` : null;
  };
  const settled = new Map<string, LinePack>();
  descriptions.forEach((d, i) => {
    const k = key(d);
    const p = alone[i];
    if (k && p && !p.ask && !settled.has(k)) settled.set(k, p);
  });
  return descriptions.map((d, i) => {
    const k = key(d);
    const own = alone[i] ?? null;
    const sibling = k ? settled.get(k) : undefined;
    if (!sibling || (own && !own.ask)) return own;
    // Only a line of the same product with nothing settled of its own takes
    // the sibling's reading; its colour stays its own.
    return { count: sibling.count, each: sibling.each, whole: sibling.whole, colour: mixOf(d, sibling.count), ask: false };
  });
}

/** The question an unsettled pack asks, in the card's words. */
export function packChoiceWords(p: Pick<LinePack, "count" | "each" | "whole">): { several: string; one: string } {
  return { several: `${p.count} of ${p.each}`, one: `one of ${p.whole}` };
}
