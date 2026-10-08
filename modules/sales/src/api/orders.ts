// /orders — sales orders + their nested /items, plus POST /:id/fulfill which
// decrements the sold parts from inventory stock. customer_name is dual-written
// from a linked customer's name so cross-module readers stay correct.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { likeEscape, platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb, type SalesOrderStatus } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { orderAvailability } from "../availability.js";
import { fulfilOrder } from "../fulfilment.js";
import { nextOrderNumber } from "../order-number.js";
import { orderHappened, readHistory } from "../history.js";
import { addLine, changeLine, removeLine } from "../order-lines.js";
import { cancelOrder, reinstateOrder } from "../cancel.js";
import { shipOrder, shipPreview } from "../ship.js";
import { workOrdersFor } from "../work-orders.js";
import { makeLine, makeIdsByWorkOrder } from "../make-line.js";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";

export const ordersRouter = Router({ mergeParams: true });

const Status = z.enum(["draft", "confirmed", "fulfilled", "shipped", "closed", "cancelled"]);

import { closeDeliveredOrder, undoDeliveryClose } from "../close-delivered.js";

const OrderCreate = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  order_number: z.string().max(160).nullable().optional(),
  status: Status.optional(),
  paid: z.boolean().optional(),
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

/** The order in the path, if it is in this collection. A line route checked
 *  only that the line was the order's, so an order in another instance could
 *  be edited through this one's address. */
async function orderHere(req: import("express").Request): Promise<boolean> {
  const row = await tenantDb(req)
    .selectFrom("sales_orders")
    .select("id")
    .where("id", "=", req.params.id!)
    .where("instance", "=", instanceOf(req))
    .executeTakeFirst();
  return !!row;
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
const ORDER_SORTS = {
  newest: [["order_date", "desc"], ["created_at", "desc"]],
  oldest: [["order_date", "asc"], ["created_at", "asc"]],
  customer: [["customer_name", "asc"], ["created_at", "desc"]],
  number: [["order_number", "desc"], ["created_at", "desc"]],
} as const;
const OrderList = z.object({
  q: z.string().trim().max(200).optional(),
  status: Status.optional(),
  paid: z.boolean().optional(),
  sort: z.enum(Object.keys(ORDER_SORTS) as [keyof typeof ORDER_SORTS, ...Array<keyof typeof ORDER_SORTS>]).optional(),
});

/** A page of orders and how many match: search over the customer, the order
 *  number and the notes, one status, and an order. */
ordersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const f = OrderList.safeParse(req.query);
    if (!f.success) return badBody(res, f.error);
    const page = readListPage(req.query);
    let q = tenantDb(req).selectFrom("sales_orders").selectAll().where("instance", "=", instanceOf(req));
    if (f.data.q) {
      const like = `%${likeEscape(f.data.q)}%`;
      q = q.where((eb) => eb.or([eb("customer_name", "ilike", like), eb("order_number", "ilike", like), eb("notes", "ilike", like)]));
    }
    if (f.data.status) q = q.where("status", "=", f.data.status);
    for (const [col, dir] of ORDER_SORTS[f.data.sort ?? "newest"]) q = q.orderBy(sql`${sql.ref(col)} ${sql.raw(dir)} nulls last`);
    const rows = await q
      .orderBy("id")
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    res.json(pagedAnswer(rows, page));
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
    // What is being made for it, and how many of each are made so far.
    const makes = await makeIdsByWorkOrder(db, order.id);
    const work_orders = (await workOrdersFor(tenantContext(req).org.id, order.id)).map((w) => ({ ...w, make_id: makes.get(w.id) ?? null }));
    const availability = await orderAvailability(tenantContext(req).org.id, items.map((it) => ({ ...it, qty: Number(it.qty), qty_fulfilled: Number(it.qty_fulfilled) })), work_orders);
    res.json({ ...order, items, total, work_orders, availability });
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
        order_number: parsed.data.order_number?.trim() || (await nextOrderNumber(db, instanceOf(req))),
        status: parsed.data.status ?? "draft",
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await orderHappened(db, ctx.org.id, row.id, { kind: "status", to_status: row.status, by_user: sessionUser(req)?.id ?? null });
    await platform().events.emit("sales.order.created", { orgId: ctx.org.id, orderId: row.id });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "order_created",
      ref: { module: "sales", entityType: "order", entityId: row.id },
      diff: { name: row.order_number ?? row.customer_name ?? row.id, instance: instanceOf(req) },
    });
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
      .select(["status", "auto_closed_at"])
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    // Picking "fulfilled", "shipped" or "closed" from the status list must not
    // be a second way to ship: it would close an order whose parts never left
    // stock. While a tracked part is still owed, the way there is Fulfill.
    const SHIPPED: SalesOrderStatus[] = ["fulfilled", "shipped", "closed"];
    // Cancelling from the status list is the same cancel as the button: what
    // Fulfill took goes back, and a shipped order is asked whether it came
    // back. The rest of the patch, if any, is applied after.
    if (parsed.data.status === "cancelled" && before.status !== "cancelled") {
      const c = await cancelOrder(db, ctx.org.id, sessionUser(req)?.id ?? null, req.params.id!, {});
      if (!c.ok) {
        res.status(c.code === "not_found" ? 404 : 409).json({ error: { code: c.code, message: c.message } });
        return;
      }
      delete (parsed.data as { status?: unknown }).status;
    }
    if (parsed.data.status && SHIPPED.includes(parsed.data.status) && !SHIPPED.includes(before.status)) {
      const owed = await db
        .selectFrom("sales_order_items")
        .select("id")
        .where("order_id", "=", req.params.id!)
        .where("part_id", "is not", null)
        .where(sql<boolean>`qty_fulfilled < qty`)
        .executeTakeFirst();
      if (owed) {
        res.status(409).json({
          error: { code: "fulfil_first", message: "Some of this order's parts have not come out of stock yet. Use Fulfill, so what it ships is taken from stock." },
        });
        return;
      }
    }
    // Custom fields MERGE into the live row (withMetadataMerged, #3625).
    const patch: Record<string, unknown> = withMetadataMerged({ ...parsed.data, updated_at: new Date() } as Record<string, unknown>);
    if (parsed.data.status && parsed.data.status !== before.status) {
      patch.auto_closed_at = null;
      if (before.auto_closed_at) patch.auto_close_undone = true;
    }
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
      await orderHappened(db, ctx.org.id, row.id, { kind: "status", from_status: before.status, to_status: parsed.data.status, by_user: sessionUser(req)?.id ?? null });
    }
    // The request as sent, on the record's history (#3625).
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "order_updated",
      ref: { module: "sales", entityType: "order", entityId: String(req.params.id) },
      diff: parsed.data as Record<string, unknown>,
      before,
    });
    if (parsed.data.paid !== undefined) await closeDeliveredOrder(db, ctx.org.id, row.id);
    res.json(await db.selectFrom("sales_orders").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow());
  }),
);

ordersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const gone = await db
      .deleteFrom("sales_orders")
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "order_number", "customer_name", "status"])
      .executeTakeFirst();
    if (!gone) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    // Its timeline goes with it, so the workspace log is where it is remembered.
    await platform().events.emit("sales.order.deleted", { orgId: ctx.org.id, orderId: gone.id });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "order_deleted",
      ref: { module: "sales", entityType: "order", entityId: gone.id },
      diff: { name: gone.order_number ?? gone.customer_name ?? gone.id, customer: gone.customer_name, status: gone.status },
    });
    res.status(204).end();
  }),
);

// ── cancel ─────────────────────────────────────────────────────────
const CancelBody = z.object({ returned: z.boolean().optional() });
// AI-REACH: action sales:cancel-order
ordersRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:cancel-order"))) return;
    const body = CancelBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const r = await cancelOrder(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, body.data);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json(r);
  }),
);

// The way back from a cancel: the person's Undo sends what the cancel answered.
const Reinstate = z.object({
  from: Status,
  restocked: z.array(z.object({ line_id: z.string().uuid(), part_id: z.string().uuid(), qty: z.number().positive() })),
});
// AI-REACH: action sales:reinstate-order
ordersRouter.post(
  "/:id/reinstate",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:reinstate-order"))) return;
    const body = Reinstate.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const r = await reinstateOrder(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, body.data);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json(r);
  }),
);

// ── line items ─────────────────────────────────────────────────────
// AI-ACTION: sales:add-line
ordersRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:add-line"))) return;
    const parsed = ItemCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const row = await addLine(db, tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, parsed.data);
    res.status(201).json(row);
  }),
);

// AI-REACH: edits a line on a financial record; add-line is the door, edits and removals stay a person's
ordersRouter.patch(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ItemUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const row = await changeLine(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, req.params.itemId!, parsed.data);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "line item not found" } });
      return;
    }
    res.json(row);
  }),
);

// AI-REACH: removing a line from a financial record is something a person watches happen; adding has an action
ordersRouter.delete(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const row = await removeLine(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.itemId!, req.params.id!);
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "line item not found" } });
      return;
    }
    res.status(204).end();
  }),
);

// ── make ───────────────────────────────────────────────────────────
// "Make this" on a line: a work order in builds for the line's part, made for
// this order, which closes itself when that many good ones are counted.
const MakeBody = z.object({ qty: z.number().int().positive().max(100_000) });
// AI-REACH: action sales:make-line
ordersRouter.post(
  "/:id/items/:itemId/make",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:make-line"))) return;
    const body = MakeBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const r = await makeLine(db, ctx.org.id, session?.id ?? null, req.params.id!, req.params.itemId!, body.data.qty, instanceOf(req));
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      return void res.status(status).json({ error: { code: r.code, message: r.message }, doors: r.doors ?? [] });
    }
    res.status(201).json(r);
  }),
);

// ── ship ───────────────────────────────────────────────────────────
// What Ship will say to the customer, and whether it can email it, before
// anything moves: the dialog shows the words first.
// AI-REACH: the words of a notice a person reads before pressing Ship; sales:ship-order is the action
ordersRouter.get(
  "/:id/ship-preview",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const tracking = typeof req.query.tracking_number === "string" ? req.query.tracking_number.trim() : "";
    const own = await db.selectFrom("sales_orders").select("id").where("id", "=", req.params.id!).where("instance", "=", instanceOf(req)).executeTakeFirst();
    if (!own) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    const p = await shipPreview(db, ctx.org.id, ctx.org.name, own.id, tracking);
    if (!p) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    res.json(p);
  }),
);

// Ship: carrier + tracking on the order, status shipped, history, and the
// customer emailed ONLY when this person ticked "Email the customer".
const ShipBody = z.object({
  tracking_number: z.string().max(120).nullable().optional(),
  carrier: z.string().max(120).nullable().optional(),
  email_customer: z.boolean().optional(),
});
// AI-REACH: action sales:ship-order
ordersRouter.post(
  "/:id/ship",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:ship-order"))) return;
    const body = ShipBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const own = await db.selectFrom("sales_orders").select("id").where("id", "=", req.params.id!).where("instance", "=", instanceOf(req)).executeTakeFirst();
    if (!own) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    const r = await shipOrder(db, ctx.org.id, {
      orderId: own.id,
      shop: ctx.org.name,
      userId: session?.id ?? null,
      trackingNumber: body.data.tracking_number ?? null,
      carrier: body.data.carrier ?? null,
      emailCustomer: body.data.email_customer && session?.id ? { pressedBy: session.id } : null,
    });
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      return void res.status(status).json({ error: { code: r.code, message: r.message }, shortages: r.shortages, doors: r.doors });
    }
    const order = await db.selectFrom("sales_orders").selectAll().where("id", "=", own.id).executeTakeFirstOrThrow();
    res.json({ order, ...r });
  }),
);

// The order's history, oldest first, with the member names resolved.
// AI-REACH: a read of what already happened; the order's own detail carries it
ordersRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const own = await db.selectFrom("sales_orders").select("id").where("id", "=", req.params.id!).where("instance", "=", instanceOf(req)).executeTakeFirst();
    if (!own) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    const rows = await readHistory(db, own.id);
    const ids = [...new Set(rows.map((r) => r.by_user).filter((x): x is string => !!x))];
    const names = ids.length ? await platform().accounts.displayNames(ctx.org.id, ids).catch(() => ({} as Record<string, string>)) : {};
    res.json({ items: rows.map((r) => ({ ...r, by_name: r.by_user ? (names[r.by_user] ?? null) : null })) });
  }),
);

// ── fulfil ─────────────────────────────────────────────────────────
// Refuses an order short of stock with a sentence and its doors (make more /
// ship what you have) instead of shipping parts that do not exist (#4050).
// `{ ship: "available" }` is the second door: ship what is on hand, keep the
// rest open.
const FulfilBody = z.object({ ship: z.enum(["all", "available"]).default("all") });
// AI-ACTION: sales:fulfill-order
ordersRouter.post(
  "/:id/fulfill",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:fulfill-order"))) return;
    const body = FulfilBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const order = await db
      .selectFrom("sales_orders")
      .select(["id"])
      .where("id", "=", req.params.id!)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!order) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const result = await fulfilOrder(db, ctx.org.id, session?.id ?? null, order.id, body.data.ship);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : 409;
      res.status(status).json({ error: { code: result.code, message: result.message }, shortages: result.shortages, doors: result.doors });
      return;
    }
    const updated = await db.selectFrom("sales_orders").selectAll().where("id", "=", order.id).executeTakeFirstOrThrow();
    const decremented = result.shipped.map((s) => ({ part_id: s.part_id, qty: s.qty }));
    await platform().events.emit("sales.order.fulfilled", {
      orgId: ctx.org.id,
      orderId: order.id,
      decremented,
      complete: result.complete,
    });
    res.json({ order: updated, decremented, complete: result.complete });
  }),
);

// AI-REACH: exempt — Undo of an automatic close, offered only by the order sheet or its notification
ordersRouter.post("/:id/undo-delivery-close", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  if (!(await orderHere(req))) {
    res.status(404).json({ error: { code: "not_found", message: "Order not found" } });
    return;
  }
  const undone = await undoDeliveryClose(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!);
  res.json({ undone });
}));
