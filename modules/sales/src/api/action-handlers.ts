// sales action handlers. `sales.fulfill-order` is the userInvokable + wire
// target: take each line item's part out of inventory stock + stamp
// fulfilled, or refuse when stock is short. One implementation with the route
// (fulfilment.ts).

import { type Kysely } from "kysely";
import { orderHappened } from "../history.js";
import { addLine } from "../order-lines.js";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "../db.js";
import { fulfilOrder } from "../fulfilment.js";
import { cancelOrder, reinstateOrder, type Restocked } from "../cancel.js";
import { nextOrderNumber } from "../order-number.js";
import { shipOrder } from "../ship.js";
import { makeLine } from "../make-line.js";

let registered = false;

interface FulfillArgs {
  order_id?: string;
  /** "available" ships what is on hand and leaves the rest open. */
  ship?: string;
}

export function registerSalesActionHandlers(): void {
  if (registered) return;
  registered = true;

  // Cancel, and its way back. A cancel of a shipped order with no answer to
  // "did it come back?" is refused with that question, never guessed.
  platform().actions.registerHandler("sales.cancel-order", async (ctx) => {
    if (ctx.entity?.kind !== "sales:order") return { ok: false, error: "cancel works on a sales order" };
    const raw = (ctx.args as { returned?: unknown } | null)?.returned;
    const returned = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await cancelOrder(db, ctx.orgId, ctx.userId, ctx.entity.id, { returned });
    if (!r.ok) return r.code === "already_cancelled" ? { ok: true, skipped: r.message } : { ok: false, error: r.message, code: r.code };
    return { ok: true, from: r.from, restocked: r.restocked };
  });
  platform().actions.registerHandler("sales.reinstate-order", async (ctx) => {
    if (ctx.entity?.kind !== "sales:order") return { ok: false, error: "reinstate works on a sales order" };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const restocked = readJsonArg<Restocked[]>(args, "restocked") ?? [];
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await reinstateOrder(db, ctx.orgId, ctx.userId, ctx.entity.id, { from: String(args.from ?? "confirmed") as SalesOrderStatus, restocked });
    return r.ok ? { ok: true, retaken: r.retaken } : { ok: false, error: r.message };
  });
  platform().actions.registerUndo("sales.cancel-order", (result, ctx) => {
    const r = result as { ok?: unknown; from?: unknown; restocked?: unknown } | null;
    if (r?.ok !== true || typeof r.from !== "string" || !ctx.entity) return null;
    return { action_id: "sales:reinstate-order", args: { from: r.from, restocked: JSON.stringify(r.restocked ?? []) }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });

  platform().actions.registerHandler("sales.fulfill-order", async (ctx) => {
    const args = (ctx.args as FulfillArgs | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    if (!orderId) return { ok: false, skipped: "no order_id" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const result = await fulfilOrder(db, ctx.orgId, ctx.userId, orderId, args.ship === "available" ? "available" : "all");
    if (!result.ok) {
      if (result.code === "already_fulfilled") return { ok: true, skipped: result.message };
      // A shortage refuses with the same sentence the order's page shows.
      return { ok: false, error: result.message, code: result.code, shortages: result.shortages };
    }
    const decremented = result.shipped.map((s) => ({ part_id: s.part_id, qty: s.qty }));
    void platform().events.emit("sales.order.fulfilled", { orgId: ctx.orgId, orderId, decremented, complete: result.complete, viaWire: ctx.event?.trigger_type === "event" });
    return { ok: true, orderId, decremented, complete: result.complete };
  });

  // sales.ship-order: carrier + tracking on the order and status shipped, for
  // a wire or the assistant. It NEVER emails the customer: only a person
  // pressing Ship with "Email the customer" ticked does that (ship.ts).
  platform().actions.registerHandler("sales.ship-order", async (ctx) => {
    const args = (ctx.args as { order_id?: string; tracking_number?: string; carrier?: string } | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    if (!orderId) return { ok: false, skipped: "no order_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await shipOrder(db, ctx.orgId, {
      orderId,
      shop: "",
      userId: ctx.userId,
      trackingNumber: args.tracking_number ?? null,
      carrier: args.carrier ?? null,
      emailCustomer: null,
    });
    if (!r.ok) return { ok: false, error: r.message, code: r.code };
    return { ok: true, orderId, carrier: r.carrier, tracking_number: r.tracking_number, tracking_url: r.lookup?.url ?? null };
  });

  // sales.make-line: "Make this" for an order line, for the assistant or a
  // wire. Plans a builds work order for the line's part (make-line.ts).
  platform().actions.registerHandler("sales.make-line", async (ctx) => {
    const args = (ctx.args as { order_id?: string; line_id?: string; qty?: number } | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    const qty = Math.floor(Number(args.qty));
    if (!orderId || !args.line_id || !(qty > 0)) return { ok: false, error: "Name the order, the line and how many to make." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await makeLine(db, ctx.orgId, ctx.userId, orderId, args.line_id, qty);
    return r.ok ? r : { ok: false, error: r.message, code: r.code };
  });

  // sales.create-order — programmatic create (e.g. importing a Woo/Shopify order).
  // Optionally upserts the customer (by email), creates the order + line items,
  // and emits sales.order.created. Mirrors the POST / route's insert shape.
  platform().actions.registerHandler("sales.create-order", async (ctx) => {
    // customer / items / metadata are structured args, and a wire's arg field
    // can only send text — so read them through readJsonArg rather than
    // trusting they arrived already parsed.
    const raw = (ctx.args ?? {}) as Record<string, unknown>;
    const args: CreateOrderArgs = {
      ...(raw as CreateOrderArgs),
      customer: readJsonArg<CreateOrderArgs["customer"]>(raw, "customer"),
      items: readJsonArg<CreateOrderArgs["items"]>(raw, "items"),
      metadata: readJsonArg<CreateOrderArgs["metadata"]>(raw, "metadata"),
    };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const instance = "sales";

    // An order with nothing on it is not an order: a call with no items used
    // to create an empty confirmed order and report it made (#3141).
    if (!Array.isArray(args.items) || args.items.length === 0) return { ok: false, error: "say what is on the order (items)" };
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
        await platform().activity.log({
          orgId: ctx.orgId,
          userId: ctx.userId ?? null,
          action: "customer_created",
          ref: { module: "sales", entityType: "customer", entityId: customerId },
          diff: { name: customerName ?? null },
        });
      }
    }

    const order = await db
      .insertInto("sales_orders")
      .values({
        instance,
        customer_id: customerId,
        customer_name: customerName,
        order_number: args.order_number?.trim() || (await nextOrderNumber(db, instance)),
        status: (args.status as SalesOrderStatus) ?? "confirmed",
        order_date: args.order_date ?? null,
        notes: args.notes ?? null,
        metadata: args.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    const orderId = (order as { id: string }).id;

    await orderHappened(db, ctx.orgId, orderId, { kind: "status", to_status: (order as { status: string }).status, by_user: ctx.userId ?? null });
    for (const it of args.items ?? []) {
      await addLine(db, ctx.orgId, ctx.userId ?? null, orderId, {
        part_id: it.part_id ?? null,
        description: it.description ?? null,
        qty: it.qty ?? 1,
        unit_price: it.unit_price ?? null,
        metadata: it.metadata ?? {},
      });
    }

    void platform().events.emit("sales.order.created", { orgId: ctx.orgId, orderId });
    await platform().activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId ?? null,
      action: "order_created",
      ref: { module: "sales", entityType: "order", entityId: orderId },
      diff: { name: customerName ?? orderId },
    });
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
