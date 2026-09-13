// What is on hand, when some of it is an open unit.
//
// A model tracked unit by unit keeps its count face honest: `qty` is the
// unopened, fungible spares, and an opened skein is a child record of its
// own, holding the metres left in it (consumption-ledger.md §1). Opening the
// last skein takes the count to 0, which is correct as a count and wrong as
// an answer to "do I have any yarn": the reviewer's table read Qty 0 and
// Available 0 with 160 m on the needles, and the model went "low" the
// moment the skein was opened (#2848, 2026-09-13).
//
// So the figure every stock reader compares against a minimum is ON HAND:
// the unopened count plus each open unit still holding something, in the
// count's own units (a partly used skein is still a skein you have). Metres
// are never summed across units, per the governing rule of §0; a row shows
// "1 open · 160 m" beside the count, not a blended total.
//
// The rule is stated once here and read by the list, the detail, the three
// places stock.low is emitted, and the attention feed, because it used to be
// `qty <= min_qty` spelled in each of them.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { InventoryDB } from "./db.js";

/** The metadata key an opened unit carries, naming its model (perUnit.ts). */
export const UNIT_OF_KEY = "unit_of";

/** One open unit of a model: what is left in it, in its own unit. */
export interface OpenUnit {
  id: string;
  qty: number;
  unit: string | null;
}

/** What the list and the detail carry for a model with open units. */
export interface OpenUnitsSummary {
  count: number;
  remaining: OpenUnit[];
}

/** The count on hand: unopened plus every open unit still holding something. */
export function onHandCount(qty: number, openUnits: readonly { qty: number }[]): number {
  const base = Number.isFinite(qty) ? Math.max(0, qty) : 0;
  return base + openUnits.filter((u) => u.qty > 0).length;
}

/** Is stock low? At or below the minimum, compared on what is available to
 *  use: on hand minus what is reserved. "Re-buy when down to 1" means the
 *  last one, open or not, is the moment. No minimum, nothing is ever low;
 *  an estimate is never low, its count is 0 because nobody counted, not
 *  because the bin is empty. */
export function isLowStock(input: { onHand: number; assigned?: number; minQty: number | null; approximate?: number | null }): boolean {
  if (input.minQty == null) return false;
  if (input.approximate != null) return false;
  return input.onHand - (input.assigned ?? 0) <= input.minQty;
}

/** The model an open unit belongs to, or null for a record that is not a
 *  unit of anything. */
export async function modelOfUnit(db: Kysely<InventoryDB>, unitId: string): Promise<{ id: string; qty: number; minQty: number | null } | null> {
  const row = await db
    .selectFrom("inventory_parts as u")
    .innerJoin("inventory_parts as m", (join) => join.on(sql<boolean>`m.id::text = u.metadata->>${UNIT_OF_KEY}`))
    .select(["m.id as id", "m.qty as qty", "m.min_qty as min_qty"])
    .where("u.id", "=", unitId)
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id, qty: Number(row.qty), minQty: row.min_qty == null ? null : Number(row.min_qty) };
}

/** Is this model low on what is on hand, open units included? */
export async function modelIsLow(db: Kysely<InventoryDB>, model: { id: string; qty: number; minQty: number | null }): Promise<{ onHand: number; low: boolean }> {
  const onHand = onHandCount(model.qty, (await openUnitsFor(db, [model.id])).get(model.id) ?? []);
  return { onHand, low: isLowStock({ onHand, minQty: model.minQty }) };
}

/** The open units of each of these models, in ONE query for the page: the
 *  children marked as a unit of the model, still holding something. A model
 *  with none is absent from the map. */
export async function openUnitsFor(db: Kysely<InventoryDB>, modelIds: readonly string[]): Promise<Map<string, OpenUnit[]>> {
  const out = new Map<string, OpenUnit[]>();
  if (modelIds.length === 0) return out;
  const rows = await db
    .selectFrom("inventory_parts")
    .select(["id", "qty", "unit", sql<string | null>`metadata->>${UNIT_OF_KEY}`.as("model_id")])
    .where(sql<boolean>`metadata->>${UNIT_OF_KEY} in (${sql.join(modelIds.map((m) => sql`${m}`))})`)
    .where(sql<boolean>`qty > 0`)
    .execute();
  for (const r of rows) {
    if (!r.model_id) continue;
    const list = out.get(r.model_id) ?? [];
    list.push({ id: r.id, qty: Number(r.qty), unit: r.unit ?? null });
    out.set(r.model_id, list);
  }
  return out;
}

/** The summary a row carries, or null when the model has no open units, so
 *  a plain part pays nothing and reads as before. `unit` is the kind's
 *  consumption unit (consumption-unit.ts) and wins over what the child row
 *  stored: an open skein minted before the rule existed carries the count's
 *  unit, and its 160 are metres all the same (#2883). Null keeps the row's. */
export function openUnitsSummary(units: readonly OpenUnit[] | undefined, unit?: string | null): OpenUnitsSummary | null {
  const live = (units ?? []).filter((u) => u.qty > 0).map((u) => (unit ? { ...u, unit } : u));
  return live.length ? { count: live.length, remaining: live } : null;
}
