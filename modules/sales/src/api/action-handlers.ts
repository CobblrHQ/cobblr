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

  // sales.create-order — programmatic create (e.g. importing a Woo/Shopify order).
  // Optionally upserts the customer (by email), creates the order + line items,
  // and emits sales.order.created. Mirrors the POST / route's insert shape.
  platform().actions.registerHandler("sales.create-order", async (ctx) => {
    const args = (ctx.args as CreateOrderArgs | null) ?? {};
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const instance = "sales";

    let customerId: string | null = null;
    let customerName: string | null = args.customer?.name?.trim() || null;
    if (args.customer && (args.customer.email || args.customer.name)) {
      const email = args.customer.email?.trim() || null;
      if (email) {
        const existing = await db
          .selectFrom("sales_customers")
          .select(["id", "name"])
          .where("instance", "=", instance)
          .where("email", "=", email)
          .executeTakeFirst();
        if (existing) {
          customerId = existing.id;
          customerName = customerName ?? existing.name;
        }
      }
      if (!customerId) {
        const c = await db
          .insertInto("sales_customers")
          .values({
            instance,
            name: args.customer.name?.trim() || email || "Customer",
            email,
            phone: args.customer.phone ?? null,
            address: args.customer.address ?? null,
            metadata: {},
          } as never)
          .returningAll()
          .executeTakeFirstOrThrow();
        customerId = (c as { id: string }).id;
        customerName = customerName ?? (c as { name: string }).name;
        void platform().events.emit("sales.customer.created", { orgId: ctx.orgId, customerId, userId: ctx.userId });
      }
    }

    const order = await db
      .insertInto("sales_orders")
      .values({
        instance,
        customer_id: customerId,
        customer_name: customerName,
        order_number: args.order_number ?? null,
        status: (args.status as SalesOrderStatus) ?? "confirmed",
        order_date: args.order_date ?? null,
        notes: args.notes ?? null,
        metadata: args.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    const orderId = (order as { id: string }).id;

    for (const it of args.items ?? []) {
      await db
        .insertInto("sales_order_items")
        .values({
          order_id: orderId,
          part_id: it.part_id ?? null,
          description: it.description ?? null,
          qty: it.qty ?? 1,
          unit_price: it.unit_price ?? null,
          metadata: it.metadata ?? {},
        } as never)
        .execute();
    }

    void platform().events.emit("sales.order.created", { orgId: ctx.orgId, orderId });
    return { ok: true, orderId, customerId };
  });
}

interface CreateOrderArgs {
  order_number?: string;
  status?: string;
  order_date?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  customer?: { name?: string; email?: string; phone?: string; address?: string };
  items?: Array<{ part_id?: string; description?: string; qty?: number; unit_price?: number; metadata?: Record<string, unknown> }>;
}
