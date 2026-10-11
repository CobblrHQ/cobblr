// The lot numbers a row's boxes printed, counted, for the record it files
// onto (#5764). A carton of ten white spools whose boxes said B32051101 three
// times and B31060501 twice files as ten, three of one batch, two of the
// other, and five whose batch nobody read: a recall names a batch, and a
// count that forgets which is which cannot answer it.

import { sql, type Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";

export interface RowLot {
  lot: string;
  qty: number;
}

const lotOf = (meta: unknown): string | null => {
  const v = (meta as { lot?: unknown } | null)?.lot;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** Count lots, at most `max` units between them, in the order first seen. */
export function tallyLots(lots: ReadonlyArray<string | null>, max: number): RowLot[] {
  const out: RowLot[] = [];
  let left = Math.trunc(max);
  for (const lot of lots) {
    if (!lot || left <= 0) continue;
    const hit = out.find((l) => l.lot === lot);
    if (hit) hit.qty += 1;
    else out.push({ lot, qty: 1 });
    left -= 1;
  }
  return out;
}

/** What a row files with: an order line's counted scans' lots, one unit
 *  each; otherwise the row's own lot for all its units. */
export async function rowLots(db: Kysely<CoreScanDB>, row: { id: string; quantity: number | string | null; suggested_metadata: unknown }, qty: number): Promise<RowLot[]> {
  const counted = await db
    .selectFrom("core_scan_inbox_items")
    .select("suggested_metadata")
    .where(sql<boolean>`suggested_metadata->>'fills_line' = ${row.id}`)
    .where("status", "=", "resolved")
    .orderBy("resolved_at")
    .execute();
  if (counted.length) return tallyLots(counted.map((c) => lotOf(c.suggested_metadata)), qty);
  const own = lotOf(row.suggested_metadata);
  return own && qty > 0 ? [{ lot: own, qty: Math.trunc(qty) }] : [];
}
