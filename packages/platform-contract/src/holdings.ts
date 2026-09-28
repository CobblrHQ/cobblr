// One thing held in several places: what its card says at the top.
//
// A card is a record, and its rows are records of the same kind paired to it
// (`holding-of`: the same supply at another location; `unit-of`: one
// individual of the counted N). The card's own location and quantity are its
// first row, so combining two records that already exist invents nothing.
// See docs/design-decisions/holdings-and-units.md.
//
// The server builds the card's summary and the web draws it; both read this,
// so the total at the top of a card can never disagree with the rows under it.

/** The pairing that makes a record a HOLDING of a card: the same thing, kept at
 *  another location. Source is the holding, target is the card. */
export const HOLDING_OF = "holding-of";

/** The pairing that makes a record one addressable UNIT of a card (a serial, a
 *  named machine). Source is the unit, target is the card. */
export const UNIT_OF = "unit-of";

/** One row under a card, as far as its summary is concerned. */
export interface HoldingFigures {
  qty: number;
  /** This row's own minimum; null when it has none. */
  min_qty: number | null;
  /** Whether this row is low by its own rule (on hand minus reserved at or
   *  under its minimum; an estimate is never low). */
  low: boolean;
  /** The soonest date any stock in this row goes off; null when undated. */
  expires_on: string | null;
}

export interface CardRollup {
  /** Everything held, across every row. */
  qty: number;
  /** How many places hold it (rows with a location, the card's own included). */
  places: number;
  /** The soonest date anything in any row goes off. */
  soonest_expiry: string | null;
  /** Low somewhere: any row at or under its own minimum. A fleet total above
   *  every minimum still has an ambulance short, and that is the one to say. */
  low: boolean;
  /** How many rows are low. */
  low_count: number;
}

/** The card's summary: its own row first, then its holdings. */
export function rollupHoldings(rows: HoldingFigures[]): CardRollup {
  let qty = 0;
  let lowCount = 0;
  let soonest: string | null = null;
  for (const r of rows) {
    qty += Number.isFinite(r.qty) ? Math.max(0, r.qty) : 0;
    if (r.low) lowCount++;
    if (r.expires_on && (soonest === null || r.expires_on < soonest)) soonest = r.expires_on;
  }
  return { qty, places: rows.length, soonest_expiry: soonest, low: lowCount > 0, low_count: lowCount };
}

/** Fields that say WHAT a thing is, as opposed to where it is or how many are
 *  there. Edited on the card and written to its holdings, so a supply cannot
 *  be "Gauze pad 4x4" in the closet and "Gauze 4x4" in the ambulance. A unit
 *  keeps its own name: being addressable is the point of one. */
export const HOLDING_IDENTITY_FIELDS = [
  "name",
  "description",
  "category_id",
  "manufacturer",
  "model_number",
  "image_path",
  "unit",
  "supplier_url",
] as const;
export type HoldingIdentityField = (typeof HOLDING_IDENTITY_FIELDS)[number];

/** The identity half of a patch: what a card's edit passes on to its holdings. */
export function identityPatch(patch: Record<string, unknown>): Partial<Record<HoldingIdentityField, unknown>> {
  const out: Partial<Record<HoldingIdentityField, unknown>> = {};
  for (const k of HOLDING_IDENTITY_FIELDS) if (k in patch) out[k] = patch[k];
  return out;
}

/** Metadata that belongs to the stock in one place, never copied to a new
 *  holding: its lots, their dates, and anything counted there. */
export const PER_PLACE_METADATA = [
  "batches",
  "expires_on",
  "received_on",
  "opened_on",
  "last_replaced_at",
  "unit_of",
  "reconcile_dismissed",
] as const;

/** A card's metadata minus what belongs to one place: what a new holding of
 *  it starts with. */
export function identityMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const k of PER_PLACE_METADATA) delete out[k];
  return out;
}
