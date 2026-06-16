// /orders — sales orders + their nested /items, plus POST /:id/fulfill which
// decrements the sold parts from inventory stock. customer_name is dual-written
// from a linked customer's name so cross-module readers stay correct.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb, type SalesOrderStatus } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { decrementForFulfilment } from "../fulfilment.js";

export const ordersRouter = Router({ mergeParams: true });

const Status = z.enum(["draft", "confirmed", "fulfilled", "shipped", "closed", "cancelled"]);

const OrderCreate = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  order_number: z.string().max(160).nullable().optional(),
  status: Status.optional(),
  order_date: z.string().nullable().optional(),
  shipping_address: z.string().max(2_000).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const OrderUpdate = OrderCreate.partial();

const ItemCreate = z.object({
  part_id: z.string().uuid().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  qty: z.number().positive(),
  unit_price: z.number().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const ItemUpdate = ItemCreate.partial();

// Resolve the customer_name to store: a linked customer's name when customer_id
// is set, else the explicit text. undefined = leave as-is.
async function customerNameFor(
  req: import("express").Request,
  customerId: string | null | undefined,
  customerName: string | null | undefined,
): Promise<string | null | undefined> {
  if (customerId) {
    const c = await tenantDb(req)
      .selectFrom("sales_customers")
      .select("name")
      .where("id", "=", customerId)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (c) return c.name;
  }
  if (customerId === null) return customerName ?? null;
  return customerName;
}

async function loadOrderLines(db: ReturnType<typeof tenantDb>, orderId: string) {
  return db
    .selectFrom("sales_order_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .orderBy("created_at", "asc")
    .execute();
}

// ── orders ─────────────────────────────────────────────────────────
ordersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("sales_orders")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("order_date", "desc")
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();
    res.json({ items });
  }),
);

ordersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const order = await db
      .selectFrom("sales_orders")
      .selectAll()
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!order) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const items = await loadOrderLines(db, order.id);
    const total = items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0);
    res.json({ ...order, items, total });
  }),
);

ordersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OrderCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const customerName = await customerNameFor(req, parsed.data.customer_id, parsed.data.customer_name);
    const row = await db
      .insertInto("sales_orders")
      .values({
        ...parsed.data,
        customer_name: customerName,
        instance: instanceOf(req),
        status: parsed.data.status ?? "draft",
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("sales.order.created", { orgId: ctx.org.id, orderId: row.id });
    res.status(201).json(row);
  }),
);

ordersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OrderUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const before = await db
      .selectFrom("sales_orders")
      .select(["status"])
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date() };
    if ("customer_id" in parsed.data) {
      const cn = await customerNameFor(req, parsed.data.customer_id, parsed.data.customer_name);
      if (cn !== undefined) patch.customer_name = cn;
    }
    const row = await db
      .updateTable("sales_orders")
      .set(patch as never)
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirstOrThrow();
    if (parsed.data.status && parsed.data.status !== before.status) {
      await platform().events.emit("sales.order.status_changed", {
        orgId: ctx.org.id,
        orderId: row.id,
        from: before.status,
        to: parsed.data.status,
      });
    }
    res.json(row);
  }),
);

ordersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db
      .deleteFrom("sales_orders")
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .execute();
    res.status(204).end();
  }),
);

// ── line items ─────────────────────────────────────────────────────
ordersRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ItemCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .insertInto("sales_order_items")
      .values({ ...parsed.data, order_id: req.params.id!, metadata: parsed.data.metadata ?? {} } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

ordersRouter.patch(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ItemUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .updateTable("sales_order_items")
      .set({ ...parsed.data, updated_at: new Date() } as never)
      .where("id", "=", req.params.itemId!)
      .where("order_id", "=", req.params.id!)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "line item not found" } });
      return;
    }
    res.json(row);
  }),
);

ordersRouter.delete(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db
      .deleteFrom("sales_order_items")
      .where("id", "=", req.params.itemId!)
      .where("order_id", "=", req.params.id!)
      .execute();
    res.status(204).end();
  }),
);

// ── fulfil ─────────────────────────────────────────────────────────
ordersRouter.post(
  "/:id/fulfill",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const order = await db
      .selectFrom("sales_orders")
      .selectAll()
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!order) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    if (order.status === "fulfilled" || order.status === "shipped" || order.status === "closed") {
      res.status(409).json({ error: { code: "already_fulfilled", message: `Order is already ${order.status}.` } });
      return;
    }
    const lines = await loadOrderLines(db, order.id);
    const decremented = await decrementForFulfilment(
      ctx.org.id,
      session?.id ?? null,
      order.id,
      lines.map((l) => ({ part_id: l.part_id, qty: Number(l.qty) || 0 })),
    );
    const updated = await db
      .updateTable("sales_orders")
      .set({ status: "fulfilled" as SalesOrderStatus, fulfilled_at: new Date() as never, updated_at: new Date() })
      .where("id", "=", order.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("sales.order.fulfilled", {
      orgId: ctx.org.id,
      orderId: order.id,
      decremented,
    });
    res.json({ order: updated, decremented });
  }),
);
