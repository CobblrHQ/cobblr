// A receipt kept as a purchase, now or when Purchases is turned on (#3869).
//
// The order is born when the receipt is read (order-at-parse.md). A fresh
// workspace has Purchases off, so that call answered 409 module_not_enabled,
// the order was skipped as "survivable", and nobody was told: the receipt was
// in the inbox and in no purchase. Now the skip is a state the session keeps.
// What the order WOULD have been is stored on it (`pending_purchase`), the
// session says "Turn on Purchases to keep this as a purchase", and one tap
// turns it on and records exactly the order the read would have made, through
// this one function, the same one the read itself calls.

import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { addOrderLine, tryCreateReceiptOrder, type ReceiptOrderInput } from "./receipt-order.js";

export interface PendingPurchaseLine {
  description: string;
  qty: number;
  unitCost: number | null;
  lineAmount: number | null;
}

/** Everything the order needs, as read from the receipt: what is stored on
 *  the session while Purchases is off. */
export interface PendingPurchase extends Omit<ReceiptOrderInput, "baseUrl" | "slug" | "headers"> {
  lines: PendingPurchaseLine[];
  /** The inbox rows the read made, in receipt order: rows[i] is lines[i]. */
  rowIds: string[];
  /** The item this paperwork was attached to, when it was. */
  targetItemId: string | null;
}

export interface PurchaseHttp {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
}

export type RecordOutcome =
  | { recorded: true; orderId: string }
  | { recorded: false; purchasesOff: boolean };

/** Record the receipt's order, its lines, and each row's claim on its line.
 *  When Purchases is off the plan is kept on the session instead, so it can
 *  be recorded later; any other failure is survivable, as it always was. */
export async function recordReceiptPurchase(
  db: Kysely<CoreScanDB>,
  batchId: string,
  plan: PendingPurchase,
  http: PurchaseHttp,
): Promise<RecordOutcome> {
  const { lines, rowIds, targetItemId, ...order } = plan;
  const made = await tryCreateReceiptOrder({ ...order, ...http });
  if (!made.id) {
    if (made.purchasesOff) {
      await db
        .updateTable("core_scan_batches")
        .set({ pending_purchase: JSON.stringify(plan) })
        .where("id", "=", batchId)
        .execute();
    }
    return { recorded: false, purchasesOff: made.purchasesOff };
  }
  const orderId = made.id;
  await db
    .updateTable("core_scan_batches")
    .set({ purchases_order_id: orderId, pending_purchase: null })
    .where("id", "=", batchId)
    .execute();
  // One order line per receipt line, in receipt order - the same order the
  // read made the inbox rows in - and each row remembers its line, which is
  // what lets a later confirm CLAIM it rather than add a second one.
  const lineIds: Array<string | null> = [];
  for (const line of lines) {
    lineIds.push(await addOrderLine({ ...http, orderId, description: line.description, qty: line.qty, unitCost: line.unitCost, lineAmount: line.lineAmount }));
  }
  for (let i = 0; i < rowIds.length; i++) {
    const lineId = lineIds[i] ?? null;
    if (!lineId) continue;
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ receipt_order_id: orderId, receipt_order_item_id: lineId }) as never })
      .where("id", "=", rowIds[i]!)
      .execute();
  }
  // The item this paperwork was attached to now knows its purchase. A
  // user-owned key: an AI re-run has no standing to forget which receipt a
  // person filed.
  if (targetItemId) {
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: mergeMeta({ purchases_order_id: orderId, receipt_group_id: plan.groupId }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", targetItemId)
      .execute();
  }
  return { recorded: true, orderId };
}

/** The plan stored on a session, when it is one. */
export function pendingPurchaseOf(raw: unknown): PendingPurchase | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<PendingPurchase>;
  return Array.isArray(p.lines) && Array.isArray(p.rowIds) && typeof p.groupId === "string" ? (p as PendingPurchase) : null;
}
