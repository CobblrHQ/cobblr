// The single writer of the inventory_consumption ledger.
//
// consumption-ledger.md §7.3 ("prevent the class"): with ONE ledger writer, no
// stock path can move a part's qty without leaving a statement line. Before P2,
// three paths decremented qty independently and only ONE of them
// (action-handlers' applyStockDelta) wrote the ledger — the HTTP /stock-adjust
// route and allocation-consume both silently skipped it, so a project consuming
// from a bound skein (and, latently, the per-unit panel's own Open/Use taps,
// which go through /stock-adjust) produced no statement line and the running
// balance disagreed with reality. This helper is the funnel every one of those
// paths now writes through.
//
// It only INSERTS the ledger row; it never touches inventory_parts.qty. That
// stays with each caller (some scope by instance, some run inside a broader
// transaction), and pairing the two is a per-caller decision:
//   • applyStockDelta / the /stock-adjust route pass the base db — a standalone,
//     best-effort write (a ledger hiccup must not fail the stock change).
//   • allocation-consume passes its open TRANSACTION so the qty decrement, the
//     ledger row, and the allocation status flip commit or roll back together.

import type { Kysely, Transaction } from "kysely";
import type { InventoryDB } from "../db.js";

/** A Kysely db OR an open transaction — both satisfy the insert we need. */
export type LedgerExec = Kysely<InventoryDB> | Transaction<InventoryDB>;

export interface ConsumptionEntry {
  partId: string;
  /** Signed: negative = consumed, positive = restocked/opened. */
  delta: number | string;
  reason?: string | null;
  /** Provenance: what drew it down ("allocation", "digifab:job", …). */
  sourceKind?: string | null;
  sourceId?: string | null;
}

/** Append one row to inventory_consumption. Throws on failure — the caller
 *  decides whether that's fatal (inside a transaction it should roll back) or
 *  best-effort (a standalone stock change should still succeed). */
export async function recordConsumption(exec: LedgerExec, e: ConsumptionEntry): Promise<void> {
  await exec
    .insertInto("inventory_consumption")
    .values({
      part_id: e.partId,
      delta: String(e.delta),
      reason: e.reason ?? null,
      source_kind: e.sourceKind ?? null,
      source_id: e.sourceId ?? null,
    })
    .execute();
}
