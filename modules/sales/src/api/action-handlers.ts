// sales action handlers. `sales.fulfill-order` is the userInvokable + wire
// target: decrement each line item's part from inventory stock + stamp
// fulfilled. Shares the decrement logic with the route (fulfilment.ts).

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "../db.js";
import { decrementForFulfilment } from "../fulfilment.js";

let registered = false;

interface FulfillArgs {
  order_id?: string;
}

export function registerSalesActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("sales.fulfill-order", async (ctx) => {
    const args = (ctx.args as FulfillArgs | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    if (!orderId) return { ok: false, skipped: "no order_id" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const order = await db.selectFrom("sales_orders").selectAll().where("id", "=", orderId).executeTakeFirst();
    if (!order) return { ok: false, skipped: "order not found" };
    if (order.status === "fulfilled" || order.status === "shipped" || order.status === "closed") {
      return { ok: true, skipped: `already ${order.status}` };
    }

    const lines = await db
      .selectFrom("sales_order_items")
      .select(["part_id", "qty"])
      .where("order_id", "=", orderId)
      .execute();
    const decremented = await decrementForFulfilment(
      ctx.orgId,
      ctx.userId,
      orderId,
      lines.map((l) => ({ part_id: l.part_id, qty: Number(l.qty) || 0 })),
    );

    await db
      .updateTable("sales_orders")
      .set({ status: "fulfilled" as SalesOrderStatus, fulfilled_at: new Date() as never, updated_at: new Date() })
      .where("id", "=", orderId)
      .execute();

    void platform().events.emit("sales.order.fulfilled", { orgId: ctx.orgId, orderId, decremented, viaWire: ctx.event?.trigger_type === "event" });
    return { ok: true, orderId, decremented };
  });
}
