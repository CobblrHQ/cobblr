// What follows every change to a part's count, whichever door made it.
//
// Five doors change a count: the row's stepper (/stock-adjust), a wire or
// button (applyStockDelta), a recount (set-stock), splitting a lot, and an
// edit of the record itself (PATCH qty, which is also what Cobb's update
// uses). Each used to do its own subset of what should follow. An edit did
// none of it, so a count typed down to 2 on a part whose minimum is 5 left no
// statement line and never said the part was low: the "running low" list
// and the draft purchase order never heard. A recount and a split skipped the
// ledger; a split never checked for low stock. Here it is one sequence:
//
//   1. the statement line (stock-ledger.ts), unless the caller already wrote
//      it inside its own transaction;
//   2. inventory.stock.changed;
//   3. on a decrease, inventory.stock.low when what is on hand is at or below
//      the minimum, for the part and for the model an open unit belongs to.
//
// Only a decrease announces low, so a restock never re-alerts.
// (lint:capabilities, row inventory:stock-moved, keeps these emits here.)

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { recordConsumption, type ConsumptionEntry } from "./stock-ledger.js";
import { isLowStock, modelIsLow, modelOfUnit, onHandCount, openUnitsFor } from "../on-hand.js";

export interface StockMove {
  partId: string;
  /** Signed: what actually moved. */
  delta: number;
  /** The count after the move. */
  newQty: number;
  /** The part's minimum, when it has one. */
  minQty: number | null;
  reason?: string | null;
  /** The statement line, or false when the caller wrote it already (inside
   *  its own transaction). */
  ledger?: Pick<ConsumptionEntry, "sourceKind" | "sourceId" | "kind"> | false;
  /** False for a move that is not use: a lot split into two records still
   *  holds everything it held, so it is not running low. */
  announceLow?: false;
}

/** Answers whether the part now stands at or below its minimum, so a surface
 *  that just took one off can offer the shopping list there and then. */
export async function stockMoved(db: Kysely<InventoryDB>, orgId: string, m: StockMove): Promise<{ low: boolean }> {
  if (m.ledger !== false && m.delta !== 0) {
    // Best-effort: a ledger hiccup must never fail a change already made.
    try {
      await recordConsumption(db, { partId: m.partId, delta: m.delta, reason: m.reason ?? null, ...(m.ledger ?? {}) });
    } catch (e) {
      console.error("[inventory.stockMoved] ledger write failed:", (e as Error).message);
    }
  }

  await platform().events.emit("inventory.stock.changed", {
    orgId,
    partId: m.partId,
    delta: m.delta,
    newQty: m.newQty,
    reason: m.reason ?? undefined,
  });

  // On what is on hand, open units included (on-hand.ts): opening the last
  // skein takes the count to 0 and must not put yarn on the shopping list.
  let low = false;
  if (m.minQty != null && m.minQty > 0) {
    const onHand = onHandCount(m.newQty, (await openUnitsFor(db, [m.partId])).get(m.partId) ?? []);
    low = isLowStock({ onHand, minQty: m.minQty });
  }
  if (m.delta >= 0 || m.announceLow === false) return { low };
  if (low) await platform().events.emit("inventory.stock.low", { orgId, partId: m.partId, newQty: m.newQty, minQty: m.minQty });
  // Taken off an open unit: its model may now be down to its minimum with no
  // write of its own to notice.
  const model = await modelOfUnit(db, m.partId);
  if (model && model.minQty != null && model.minQty > 0) {
    const state = await modelIsLow(db, model);
    if (state.low) await platform().events.emit("inventory.stock.low", { orgId, partId: model.id, newQty: state.onHand, minQty: model.minQty });
  }
  return { low };
}
