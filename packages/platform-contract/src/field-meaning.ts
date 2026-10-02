// VOCAB-ENUMERATION OK: this file IS the table from words to meanings; naming
// the roles is its whole content, and nothing else reads a role by its words.
//
// What a field means, read from the words someone gave it.
//
// A kind holds one field per meaning (#4518). The owner's vehicle had the
// bundle's "Bought from" and the Provenance preset's "Acquired from", and the
// platform never noticed the second was about to be made. Meanings are already
// the platform's notion of "what a field is" (field_role); a field made with
// none gets one read from its label here, so the same rule can see it.
//
// A table, not a model: these are the words people actually write for these
// facts, and a table answers the same way every time and costs nothing
// (heuristic first). The receipt mapper's name lists are reused, so the field
// a receipt fills and the field this recognises are the same field. A label
// the table does not know has no meaning until a person gives it one.
//
// Seller and where-it-came-from are a pair, never the same: "eBay" is where,
// "detroitaxle" is who (arrivals.md).

import type { FieldRole } from "@cobblr/platform-contract";
import {
  PURCHASE_PRICE_NAMES,
  PURCHASE_SELLER_NAMES,
  RECEIPT_DATE_NAMES,
  RECEIPT_FROM_NAMES,
} from "@cobblr/platform-contract/receipt-fact-names";

const snake = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Each meaning, with the words that say it. Tested on the snake_cased label
 *  and the field's own name. Order matters only where words overlap: a seller
 *  ("sold by") is checked before where-it-came-from. */
const TABLE: ReadonlyArray<{ role: FieldRole; words: RegExp }> = [
  { role: "seller", words: new RegExp(`${PURCHASE_SELLER_NAMES.source}|^(who_sold_it|sold_to_me_by|private_seller)$`) },
  {
    role: "acquired-from",
    words: new RegExp(`${RECEIPT_FROM_NAMES.source}|^(where_bought|where_purchased|where_from|where_i_got_it|got_it_from|got_from|came_from|source|acquired_at|bought_at|purchased_at)$`),
  },
  {
    role: "acquired-on",
    words: new RegExp(`${RECEIPT_DATE_NAMES.source}|^(date_of_purchase|when_bought|when_purchased|got_it_on)$`),
  },
  { role: "acquired-for", words: new RegExp(`${PURCHASE_PRICE_NAMES.source}|^(what_i_paid|purchase_cost)$`) },
  { role: "identifier", words: /^(serial|serial_number|serial_no|sn|vin|isbn|imei|asset_tag)$/ },
  { role: "expiry", words: /^(expires|expiry|expiry_date|expiration|expiration_date|best_before|use_by|use_by_date|expires_on)$/ },
  { role: "lot", words: /^(lot|lot_number|lot_no|batch|batch_number|batch_no|dye_lot)$/ },
  { role: "usage", words: /^(mileage|odometer|miles|kilometres|kilometers|hours|hour_meter|engine_hours|run_hours|print_hours|cycles)$/ },
  { role: "year-made", words: /^(vintage|year_made|year_of_manufacture|made_in_year)$/ },
];

/** The meaning these words carry, or null when the table does not know them. */
export function meaningFromWords(label: string | null | undefined, name?: string | null): FieldRole | null {
  const keys = [label, name].filter((x): x is string => !!x && !!x.trim()).map(snake);
  for (const { role, words } of TABLE) if (keys.some((k) => words.test(k))) return role;
  return null;
}

export interface FieldWithMeaning {
  name: string;
  label: string;
  field_role?: string | null;
}

/** The field this kind already has with that meaning, other than `except`.
 *  A kind holds one field per meaning; this is the one to use instead. */
export function fieldWithMeaning<T extends FieldWithMeaning>(fields: readonly T[], role: string | null | undefined, except?: string | null): T | null {
  if (!role) return null;
  return fields.find((f) => f.field_role === role && f.name !== except) ?? null;
}

/** Fields on one kind that share a meaning: the overlaps to settle, each a
 *  meaning and every field claiming it (two or more). */
export function sameMeaningGroups<T extends FieldWithMeaning>(fields: readonly T[]): Array<{ role: string; fields: T[] }> {
  const by = new Map<string, T[]>();
  for (const f of fields) {
    if (!f.field_role) continue;
    by.set(f.field_role, [...(by.get(f.field_role) ?? []), f]);
  }
  return [...by].filter(([, fs]) => fs.length > 1).map(([role, fs]) => ({ role, fields: fs }));
}
