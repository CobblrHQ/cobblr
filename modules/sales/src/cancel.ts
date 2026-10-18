// Cancelling a sales order, and taking the cancel back.
//
// A cancelled order used to keep whatever Fulfill had taken off the shelf:
// the parts left stock for a sale that never happened, and nothing said so.
// Now the rule every shop tool follows:
//   - an order that has not shipped puts back what it took, line by line;
//   - an order that HAS shipped asks whether it came back. Only a yes puts
//     the stock back; a no cancels it and leaves stock as it is (the parts
//     are with the customer).
// Every door (the route, the status list, the sales:cancel-order action)
// comes here, each change is written down through orderHappened, and the
// answer carries what reinstating needs, so a person's Undo and the
// assistant's undo take the same way back.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "./db.js";
import { withOrderLock } from "./order-lock.js";
import { orderHappened } from "./history.js";
import { orderStockComplete } from "./fulfilment.js";

const SHIPPED: readonly SalesOrderStatus[] = ["shipped", "closed"];

export interface Restocked {
  line_id: string;
  part_id: string;
  qty: number;
}

export type CancelResult =
  | { ok: true; from: SalesOrderStatus; restocked: Restocked[] }
  | { ok: false; code: "not_found" | "already_cancelled" | "ask_returned"; message: string };

async function adjust(orgId: string, userId: string | null, orderId: string, partId: string, delta: number, why: string): Promise<number> {
  const res = (await platform().actions.invoke("inventory:adjust-stock", {
    orgId,
    userId,
    entity: { kind: "inventory:part", id: partId },
    event: {
      name: "sales.order.cancelled",
      payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" },
      timestamp: new Date().toISOString(),
      trigger_type: "event",
    },
    args: { partId, delta, reason: `${why}:${orderId}`, sourceKind: "sales:order", sourceId: orderId },
  })) as { ok?: boolean; delta?: number } | null;
  return res?.ok ? Math.abs(Number(res.delta ?? 0)) : 0;
}

/** Cancel an order. `returned` answers "did a shipped order come back?";
 *  asked of an order that shipped and not given, the answer is a question. */
export async function cancelOrder(
  db: Kysely<SalesDB>,
  orgId: string,
  userId: string | null,
  orderId: string,
  opts: { returned?: boolean } = {},
): Promise<CancelResult> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const order = await db.selectFrom("sales_orders").select(["id", "status"]).where("id", "=", orderId).executeTakeFirst();
    if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
    if (order.status === "cancelled") return { ok: false, code: "already_cancelled", message: "This order is already cancelled." };
    const shipped = SHIPPED.includes(order.status);
    if (shipped && opts.returned === undefined) {
      return {
        ok: false,
        code: "ask_returned",
        message: "This order has shipped. Was it returned? If it was, what it took goes back on the shelf.",
      };
    }

    const restocked: Restocked[] = [];
    if (!shipped || opts.returned) {
      const lines = await db
        .selectFrom("sales_order_items")
        .select(["id", "part_id", "qty_fulfilled"])
        .where("order_id", "=", orderId)
        .execute();
      for (const l of lines) {
        const taken = Number(l.qty_fulfilled) || 0;
        if (!l.part_id || taken <= 0) continue;
        const back = await adjust(orgId, userId, orderId, l.part_id, taken, "sale-cancelled");
        if (back <= 0) continue;
        await db
          .updateTable("sales_order_items")
          .set({ qty_fulfilled: String(Math.max(0, taken - back)), updated_at: new Date() })
          .where("id", "=", l.id)
          .execute();
        restocked.push({ line_id: l.id, part_id: l.part_id, qty: back });
      }
    }

    await db.updateTable("sales_orders").set({ status: "cancelled", updated_at: new Date() }).where("id", "=", orderId).execute();
    if (restocked.length > 0) {
      await orderHappened(db, orgId, orderId, {
        kind: "stock",
        detail: { returned: restocked.map((r) => ({ part_id: r.part_id, qty: r.qty })), because: shipped ? "came back" : "cancelled before it shipped" },
        by_user: userId,
      });
    }
    await orderHappened(db, orgId, orderId, { kind: "status", from_status: order.status, to_status: "cancelled", by_user: userId });
    return { ok: true, from: order.status, restocked };
  });
}

/** Retake what is still on the shelf. An incomplete sale stays open for the rest. */
export async function reinstateOrder(
  db: Kysely<SalesDB>,
  orgId: string,
  userId: string | null,
  orderId: string,
  undo: { from: SalesOrderStatus; restocked: Restocked[] },
): Promise<{ ok: true; retaken: Restocked[]; status: SalesOrderStatus; complete: boolean } | { ok: false; code: "not_found" | "not_cancelled"; message: string }> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const order = await db.selectFrom("sales_orders").select(["id", "status"]).where("id", "=", orderId).executeTakeFirst();
    if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
    if (order.status !== "cancelled") return { ok: false, code: "not_cancelled", message: `This order is ${order.status}, not cancelled.` };
    const retaken: Restocked[] = [];
    for (const r of undo.restocked) {
      const took = await adjust(orgId, userId, orderId, r.part_id, -r.qty, "sale-reinstated");
      if (took <= 0) continue;
      const line = await db.selectFrom("sales_order_items").select(["qty_fulfilled"]).where("id", "=", r.line_id).where("order_id", "=", orderId).executeTakeFirst();
      if (line) {
        await db
          .updateTable("sales_order_items")
          .set({ qty_fulfilled: String((Number(line.qty_fulfilled) || 0) + took), updated_at: new Date() })
          .where("id", "=", r.line_id)
          .execute();
      }
      retaken.push({ ...r, qty: took });
    }
    const complete = await orderStockComplete(db, orderId);
    const status = !complete && ["fulfilled", "shipped", "closed"].includes(undo.from) ? "confirmed" : undo.from;
    await db.updateTable("sales_orders")
      .set({ status, ...(!complete ? { fulfilled_at: null, shipped_at: null } : {}), updated_at: new Date() })
      .where("id", "=", orderId).execute();
    if (retaken.length > 0) {
      await orderHappened(db, orgId, orderId, { kind: "stock", detail: { taken: retaken.map((r) => ({ part_id: r.part_id, qty: r.qty })), because: "the cancel was undone" }, by_user: userId });
    }
    await orderHappened(db, orgId, orderId, { kind: "status", from_status: "cancelled", to_status: status, by_user: userId });
    return { ok: true, retaken, status, complete };
  });
}
