// /orders — sales orders + their nested /items, plus POST /:id/fulfill which
// decrements the sold parts from inventory stock. customer_name is dual-written
// from a linked customer's name so cross-module readers stay correct.

import { isActionRefusal } from "@cobblr/platform-contract/action-refusal";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { fieldCurrency } from "@cobblr/platform-contract/money";
import { orderTotal } from "../invoice.js";
import { moneyOfOrders, orderMoney, recordReturn, undoReturn } from "../returns.js";
import { recordPayment, syncPaid, undoPayment } from "../payments.js";
import { heldByOthers, holdOrder, releaseHold } from "../holds.js";
import { accountingCsv, summarise } from "../summary.js";
import { arrivedEverywhere } from "@cobblr/platform-contract/day";
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

import { documentsRouter } from "./documents.js";

export const ordersRouter = Router({ mergeParams: true });
ordersRouter.use("/:id/documents", documentsRouter);

const Status = z.enum(["draft", "confirmed", "fulfilled", "shipped", "closed", "cancelled"]);

import { closeDeliveredOrder, undoDeliveryClose } from "../close-delivered.js";

const OrderCreate = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().max(200).nullable().optional(),
  order_number: z.string().max(160).nullable().optional(),
  status: Status.optional(),
  paid: z.boolean().optional(),
  order_date: z.string().nullable().optional(),
  /** When the customer wants it: an ISO date. */
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a due date is YYYY-MM-DD").nullable().optional(),
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
  due: [["due_date", "asc"], ["created_at", "asc"]],
} as const;
const OrderList = z.object({
  q: z.string().trim().max(200).optional(),
  status: Status.optional(),
  paid: z.enum(["true", "false"]).optional(),
  customer_id: z.string().uuid().optional(),
  /** One month of orders by the day they were made, YYYY-MM (#8786). */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  sort: z.enum(Object.keys(ORDER_SORTS) as [keyof typeof ORDER_SORTS, ...Array<keyof typeof ORDER_SORTS>]).optional(),
});

/** The orders a list, its summary and its accountant's export all mean by the same filters, so their totals agree. */
function matchingOrders(req: import("express").Request, f: z.infer<typeof OrderList>) {
  let q = tenantDb(req).selectFrom("sales_orders").selectAll().where("instance", "=", instanceOf(req));
  if (f.q) {
    const like = `%${likeEscape(f.q)}%`;
    q = q.where((eb) => eb.or([eb("customer_name", "ilike", like), eb("order_number", "ilike", like), eb("notes", "ilike", like)]));
  }
  if (f.status) q = q.where("status", "=", f.status);
  if (f.paid) q = q.where("paid", "=", f.paid === "true");
  if (f.customer_id) q = q.where("customer_id", "=", f.customer_id);
  if (f.month) {
    const [y, m] = f.month.split("-").map(Number) as [number, number];
    const first = `${f.month}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    q = q.where("order_date", ">=", first as never).where("order_date", "<", next as never);
  }
  return q;
}

/** A page of orders and how many match: search over the customer, the order
 *  number and the notes, one status, paid or not, one customer, and an order. */
ordersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const f = OrderList.safeParse(req.query);
    if (!f.success) return badBody(res, f.error);
    const page = readListPage(req.query);
    let q = matchingOrders(req, f.data);
    for (const [col, dir] of ORDER_SORTS[f.data.sort ?? "newest"]) q = q.orderBy(sql`${sql.ref(col)} ${sql.raw(dir)} nulls last`);
    const rows = await q
      .orderBy("id")
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    // Each order's total, the same sum its own page shows, from one read of the page's lines.
    const lines = rows.length ? await tenantDb(req).selectFrom("sales_order_items").select(["order_id", "qty", "unit_price", "metadata"]).where("order_id", "in", rows.map((r) => r.id)).execute() : [];
    const shop = await platform().money.currency(tenantContext(req).org.id);
    const money = await moneyOfOrders(tenantDb(req), rows, shop);
    const withTotals = rows.map((r) => {
      const sum = orderTotal(lines.filter((l) => l.order_id === r.id), fieldCurrency(r.metadata, "total", shop));
      const m = money.get(r.id)!;
      return { ...r, total: sum.amount, other_currency_totals: sum.other, unpriced_lines: sum.unpriced, currency: m.currency, net_total: m.net_total, refunded: m.refunded, refund_due: m.refund_due, owed: m.owed, kept: m.kept };
    });
    res.json(pagedAnswer(withTotals, page));
  }),
);

/** What a month of orders came to: sold, received, refunded, owed to the shop and owed back, per currency (#8786). Same filters and same figures as the list and the file. */
// AI-REACH: a read of figures the order list and its page already carry
ordersRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const f = OrderList.safeParse(req.query);
    if (!f.success) return badBody(res, f.error);
    // Every matching order, never a cut: a total over a part of the month would be wrong.
    const rows = await matchingOrders(req, f.data).orderBy("id").execute();
    const money = await moneyOfOrders(tenantDb(req), rows, await platform().money.currency(tenantContext(req).org.id));
    res.json({ month: f.data.month ?? null, orders: rows.length, by_currency: summarise(rows.map((r) => ({ status: r.status, paid: r.paid, money: money.get(r.id)! }))) });
  }),
);

/** Who owes the shop, and how much: every order with something still to pay, oldest first, and the sum per currency (#8838). It is the summary's owed, listed. */
// AI-REACH: a read of figures the order list and its page already carry
ordersRouter.get(
  "/owed",
  asyncHandler(async (req, res) => {
    const rows = await matchingOrders(req, {}).where("status", "!=", "cancelled").orderBy(sql`order_date asc nulls first`).orderBy("created_at").orderBy("id").execute();
    const money = await moneyOfOrders(tenantDb(req), rows, await platform().money.currency(tenantContext(req).org.id));
    const items = rows.flatMap((r) => {
      const m = money.get(r.id)!;
      return m.owed > 0 ? [{ id: r.id, order_number: r.order_number, customer_name: r.customer_name, order_date: r.order_date, status: r.status, currency: m.currency, owed: m.owed, state: m.state }] : [];
    });
    const by_currency = summarise(rows.map((r) => ({ status: r.status, paid: r.paid, money: money.get(r.id)! }))).filter((s) => s.owed > 0).map((s) => ({ currency: s.currency, owed: s.owed, orders: items.filter((i) => i.currency === s.currency).length }));
    res.json({ by_currency, items });
  }),
);

/** The accountant's file: one row per order with the same figures (#8787). */
// AI-REACH: a file of what the order list already reads, for the person to download
ordersRouter.get(
  "/accounting.csv",
  asyncHandler(async (req, res) => {
    const f = OrderList.safeParse(req.query);
    if (!f.success) return badBody(res, f.error);
    const rows = await matchingOrders(req, f.data).orderBy(sql`order_date asc nulls last`).orderBy("created_at").orderBy("id").execute();
    const money = await moneyOfOrders(tenantDb(req), rows, await platform().money.currency(tenantContext(req).org.id));
    const lastPaid = new Map<string, string>();
    if (rows.length) {
      for (const p of await tenantDb(req).selectFrom("sales_payments").select(["order_id", sql<string>`max(paid_on)::text`.as("day")]).where("order_id", "in", rows.map((r) => r.id)).groupBy("order_id").execute()) lastPaid.set(p.order_id, p.day);
    }
    const orders = await Promise.all(
      rows.map(async (r) => ({
        order_number: r.order_number,
        order_date: r.order_date,
        customer_name: r.customer_name,
        status: r.status,
        paid: r.paid,
        paid_on: lastPaid.get(r.id) ?? null,
        money: money.get(r.id)!,
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sales-for-accountant-${f.data.month ?? arrivedEverywhere(new Date())}.csv"`);
    res.send(accountingCsv(orders));
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
    const sum = orderTotal(items, fieldCurrency(order.metadata, "total", await platform().money.currency(tenantContext(req).org.id)));
    // What is being made for it, and how many of each are made so far.
    const makes = await makeIdsByWorkOrder(db, order.id);
    const work_orders = (await workOrdersFor(tenantContext(req).org.id, order.id)).map((w) => ({ ...w, make_id: makes.get(w.id) ?? null }));
    const availability = await orderAvailability(tenantContext(req).org.id, items.map((it) => ({ ...it, qty: Number(it.qty), qty_fulfilled: Number(it.qty_fulfilled) })), work_orders, await heldByOthers(db, items.flatMap((it) => (it.part_id ? [it.part_id] : [])), order.id));
    const returns = await db.selectFrom("sales_returns").selectAll().where("order_id", "=", order.id).orderBy("created_at").execute();
    const shop = await platform().money.currency(tenantContext(req).org.id);
    const payments = await db.selectFrom("sales_payments").selectAll().where("order_id", "=", order.id).orderBy("paid_on").orderBy("created_at").execute();
    const money = orderMoney(order, items, returns.map((r) => Number(r.refund_amount ?? 0)), shop, payments.map((p) => Number(p.amount)));
    res.json({ ...order, items, total: sum.amount, other_currency_totals: sum.other, unpriced_lines: sum.unpriced, work_orders, availability, returns, payments, money });
  }),
);

// AI-REACH: crud
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
        // An order starts on the day it was made, in the person's own day (#8788).
        order_date: parsed.data.order_date ?? (await platform().accounts.dayFor(sessionUser(req)?.id ?? null)),
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

// AI-REACH: crud
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
    // Paid is read from the payments (#8838): ticking it records what is still owed as one
    // payment, and unticking takes the payments back, so the flag never disagrees with them.
    if (parsed.data.paid !== undefined) {
      const id = req.params.id!;
      const paid = parsed.data.paid;
      delete (parsed.data as { paid?: unknown }).paid;
      const shop = await platform().money.currency(ctx.org.id);
      const userId = sessionUser(req)?.id ?? null;
      if (paid) {
        const full = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata"]).where("id", "=", id).executeTakeFirstOrThrow();
        const m = (await moneyOfOrders(db, [full], shop)).get(id)!;
        if (m.owed > 0) {
          const r = await recordPayment(db, ctx.org.id, userId, id, { amount: m.owed }, shop, await platform().accounts.dayFor(userId));
          if (!r.ok) {
            res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
            return;
          }
        } else if (m.state !== "paid") {
          await db.updateTable("sales_orders").set({ paid: true } as never).where("id", "=", id).execute();
        }
      } else {
        for (const p of await db.selectFrom("sales_payments").select(["id"]).where("order_id", "=", id).execute()) {
          const r = await undoPayment(db, ctx.org.id, userId, id, p.id, shop);
          if (!r.ok) {
            res.status(409).json({ error: { code: r.code, message: r.message } });
            return;
          }
        }
        await db.updateTable("sales_orders").set({ paid: false } as never).where("id", "=", id).execute();
      }
      await closeDeliveredOrder(db, ctx.org.id, id);
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
    res.json(await db.selectFrom("sales_orders").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow());
  }),
);

// AI-REACH: crud
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

// A customer's return and/or refund (#8790), and taking it back.
const ReturnBody = z.object({
  line_id: z.string().uuid().nullish(),
  qty: z.number().positive().max(1_000_000).nullish(),
  refund_amount: z.number().nonnegative().max(100_000_000).nullish(),
  reason: z.string().max(500).nullish(),
});
// AI-REACH: action sales:return-line
ordersRouter.post(
  "/:id/returns",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:return-line"))) return;
    const body = ReturnBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const ctx = tenantContext(req);
    const r = await recordReturn(tenantDb(req), ctx.org.id, sessionUser(req)?.id ?? null, req.params.id!, body.data, await platform().money.currency(ctx.org.id));
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.status(201).json(r);
  }),
);
// AI-REACH: action sales:undo-return
ordersRouter.delete(
  "/:id/returns/:returnId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:undo-return"))) return;
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const r = await undoReturn(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, req.params.returnId!);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json({ ok: true });
  }),
);

const PaymentBody = z.object({
  amount: z.number().positive().max(100_000_000),
  method: z.string().max(40).nullish(),
  paid_on: z.string().nullish(),
});
// AI-REACH: action sales:record-payment
ordersRouter.post(
  "/:id/payments",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:record-payment"))) return;
    const body = PaymentBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const r = await recordPayment(tenantDb(req), ctx.org.id, userId, req.params.id!, body.data, await platform().money.currency(ctx.org.id), await platform().accounts.dayFor(userId));
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    await closeDeliveredOrder(tenantDb(req), ctx.org.id, req.params.id!);
    res.status(201).json(r);
  }),
);
// AI-REACH: action sales:undo-payment
ordersRouter.delete(
  "/:id/payments/:paymentId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:undo-payment"))) return;
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const ctx = tenantContext(req);
    const r = await undoPayment(tenantDb(req), ctx.org.id, sessionUser(req)?.id ?? null, req.params.id!, req.params.paymentId!, await platform().money.currency(ctx.org.id));
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json({ ok: true });
  }),
);

const HoldBody = z.object({ until: z.string().nullish() });
// AI-REACH: action sales:hold-order
ordersRouter.post(
  "/:id/hold",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:hold-order"))) return;
    const body = HoldBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const r = await holdOrder(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, body.data);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.status(201).json(r);
  }),
);
// AI-REACH: action sales:release-hold
ordersRouter.delete(
  "/:id/hold",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:release-hold"))) return;
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const r = await releaseHold(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, "it was released");
    if (!r.ok) {
      res.status(404).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json({ ok: true, released: r.released });
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

// AI-ACTION: sales:change-line
ordersRouter.patch(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:change-line"))) return;
    const parsed = ItemUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (!(await orderHere(req))) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    // A line inside an order is not a kind the kernel judges, so it asks
    // here: an older tab's save over a price changed since is refused (#7925).
    const now = await tenantDb(req).selectFrom("sales_order_items").selectAll().where("id", "=", req.params.itemId!).where("order_id", "=", req.params.id!).executeTakeFirst();
    if (now && (await platform().http.refuseStaleEdit(req, res, req.params.itemId!, now as unknown as Record<string, unknown>))) return;
    let row: Awaited<ReturnType<typeof changeLine>>;
    try {
      row = await changeLine(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, req.params.itemId!, parsed.data);
    } catch (error) {
      if (!isActionRefusal(error)) throw error;
      res.status(409).json({ error: { code: "qty_already_fulfilled", message: error.message } });
      return;
    }
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "line item not found" } });
      return;
    }
    res.json(row);
  }),
);

// AI-ACTION: sales:remove-line
ordersRouter.delete(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "sales:remove-line"))) return;
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
      // A Builds that is off goes out with its app's name: the platform adds
      // the switch or the ask, and keeps this request to finish after.
      return void res.status(status).json({ error: { code: r.code, message: r.message, ...(r.module ? { module: r.module } : {}) }, doors: r.doors ?? [] });
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
