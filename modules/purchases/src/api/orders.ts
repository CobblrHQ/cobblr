import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { fieldCurrency, isCurrency } from "@cobblr/platform-contract/money";
import { orderFigures, combineOrderTotals } from "../order-money.js";
// /orders — REST for purchases orders + the nested /items collection.
// A 'status' transition to 'arrived' emits purchases.order.arrived
// so downstream wires (e.g. bump inventory stock) can react.

import { arrivedEverywhere } from "@cobblr/platform-contract";
import { receiveIfArrived, receiveOrderLines, setReceivedCount } from "../receive.js";
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { likeNeedle, platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, refuseUnknownFields, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { claimLine, stampLine } from "./line-subject.js";
import { orderTotal } from "../order-total.js";
import { editOrderLine } from "../line-edit.js";
import { listShipments } from "../shipments.js";
import { attachWaiting, orderPageSummary } from "../order-page/store.js";
import { trackingNumberFromText } from "@cobblr/platform-contract/tracking-text";
import { withCarrierNames } from "./shipments.js";

export const ordersRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top. (Audit 2026-06-26 P0 #1.)
ordersRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const OrderStatus = z.enum(["planned", "ordered", "in-transit", "arrived", "cancelled"]);

const OrderCreate = z.object({
  vendor: z.string().max(160).nullable().optional(),
  vendor_id: z.string().uuid().nullable().optional(),
  order_number: z.string().max(160).nullable().optional(),
  url: z.string().url().max(500).nullable().optional(),
  ordered_at: z.string().nullable().optional(),
  expected_arrival: z.string().nullable().optional(),
  arrived_at: z.string().nullable().optional(),
  status: OrderStatus.optional(),
  total_cost: z.number().nullable().optional(),
  shipping_cost: z.number().nullable().optional(),
  // A pasted tracking link is the number it points at (#5351).
  tracking_number: z.preprocess((v) => (typeof v === "string" && v.trim() ? trackingNumberFromText(v) ?? v : v), z.string().max(160).nullable().optional()),
  notes: z.string().max(8_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Whether the lines add their stock when the order arrives. Default on;
   *  off for a past purchase being logged, and what an importer sends. */
  add_to_stock: z.boolean().optional(),
  // Normally the arrival sweep's to write. Accepted here so a caller that has
  // ALREADY been following this parcel can hand the watch over rather than
  // restart it — core-scan files a receipt it tracked in the inbox, and without
  // this the order opens at "no information" and re-asks the carrier.
  //
  // They must be NATIVE keys: routeUnknownToMetadata() hoists anything it does
  // not recognise into `metadata`, so passing them without this would be
  // accepted, stored somewhere nothing reads, and change nothing.
  shipment_state: z.string().max(40).nullable().optional(),
  shipment_checked_at: z.string().nullable().optional(),
  shipment_next_poll_at: z.string().nullable().optional(),
  eta_source: z.string().max(40).nullable().optional(),
});
const OrderUpdate = OrderCreate.partial();

const ItemCreate = z.object({
  part_id: z.string().uuid().nullable().optional(),
  /** What the line bought, when it is not a part: any record (#3856). */
  subject_kind: z.string().min(1).max(80).nullable().optional(),
  subject_id: z.string().min(1).max(120).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  qty: z.number(),
  unit_cost: z.number().nullable().optional(),
  /** The amount the source line stated. Optional, and authoritative over
   *  qty * unit_cost when present — see migration 0007. */
  line_amount: z.number().nullable().optional(),
  consumed_by_module: z.string().max(80).nullable().optional(),
  consumed_by_entity_type: z.string().max(80).nullable().optional(),
  consumed_by_entity_id: z.string().uuid().nullable().optional(),
  received_at: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** On an order that already arrived: whether this line adds its stock.
   *  Defaults to the order's add_to_stock. Never stored on the line. */
  add_to_stock: z.boolean().optional(),
});

// D6: top-level keys the schemas know about. Anything else the caller
// POSTs gets hoisted into metadata by routeUnknownToMetadata().
// Exported because it IS the contract: anything absent from it is silently
// hoisted into `metadata` instead of reaching its column, which looks like a
// successful write and is not one. A test asserts the fields core-scan hands
// over on filing are all in here.
export const ORDER_NATIVE_KEYS = new Set(Object.keys(OrderCreate.shape));
const ITEM_NATIVE_KEYS = new Set(Object.keys(ItemCreate.shape));

// Resolve the `vendor` text an order should store: the linked vendor's name
// when vendor_id is set, else the explicit text. `undefined` (vendor_id absent
// from a PATCH body) means "leave whatever's there"; only return a value when
// we actually want to write one.
async function vendorTextFor(
  req: import("express").Request,
  vendorId: string | null | undefined,
  vendorText: string | null | undefined,
): Promise<string | null | undefined> {
  if (vendorId) {
    const v = await tenantDb(req)
      .selectFrom("purchases_vendors")
      .select("name")
      .where("id", "=", vendorId)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (v) return v.name;
  }
  if (vendorId === null) return vendorText ?? null; // unlinked → keep/clear text
  return vendorText;
}

// ── orders ───────────────────────────────────────────────────────

// The list, a page at a time, newest first. It used to stop at 500 with no
// way to the rest, and the page summed spend from what it had, so a workspace
// past 500 orders could not reach its oldest and undercounted what it spent.
// Filters run here so a search finds an order that is not on the first page.
const PAGE_MAX = 500;
const orderDay = sql<string>`coalesce(o.ordered_at, o.created_at::date)`;

interface OrderCursor {
  d: string;
  c: string;
  id: string;
}
const encodeCursor = (c: OrderCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: unknown): OrderCursor | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    // b64-lenient-ok: a list cursor only says where the next page starts; every spelling of it is the same place.
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as OrderCursor;
    return typeof c.d === "string" && typeof c.c === "string" && typeof c.id === "string" ? c : null;
  } catch {
    return null;
  }
}

/** The status and search a list and its summary share, so the figures above
 *  the list are always about the rows under them. */
function filteredOrders(req: import("express").Request) {
  const db = tenantDb(req);
  let q = db.selectFrom("purchases_orders as o").where("o.instance", "=", instanceOf(req));
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  if (status) q = q.where("o.status", "=", status as never);
  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (search) {
    const like = likeNeedle(search);
    q = q.where(sql<boolean>`(lower(coalesce(o.vendor, '')) like ${like} or lower(coalesce(o.order_number, '')) like ${like} or lower(coalesce(o.notes, '')) like ${like} or lower(coalesce(o.tracking_number, '')) like ${like})`);
  }
  return { db, q };
}

// AI-REACH: exempt — dashboard-only aggregate; Cobb reads orders.
ordersRouter.get("/dashboard", asyncHandler(async (req, res) => {
  const counts = await tenantDb(req).selectFrom("purchases_orders")
    .select([sql<number>`count(*)::int`.as("total"), sql<number>`count(*) filter (where status not in ('arrived', 'cancelled'))::int`.as("open")])
    .where("instance", "=", instanceOf(req)).executeTakeFirstOrThrow();
  res.json(counts);
}));

ordersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // ?receipt_group_id=<id> — "which order did THIS receipt become?". The
    // scan card's contributed panel asks it, handing over only the host's own
    // identifier; the answer is found in this module's own metadata, where the
    // receipt import stamped it. One row, so no pagination question.
    const receiptGroupId =
      typeof req.query.receipt_group_id === "string" ? req.query.receipt_group_id : null;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), PAGE_MAX) : PAGE_MAX;
    const cursor = decodeCursor(req.query.cursor);
    const { q } = filteredOrders(req);
    let rows = q
      .selectAll("o")
      .select(orderTotal("o").as("total"))
      .select(sql<string>`to_char(${orderDay}, 'YYYY-MM-DD')`.as("sort_day"))
      // Full precision: a JS Date keeps milliseconds, the column keeps
      // microseconds, and a cursor rounded down skips the rows in between.
      .select(sql<string>`o.created_at::text`.as("sort_created"))
      .select((eb) =>
        eb
          .selectFrom("purchases_order_items as i")
          .whereRef("i.order_id", "=", "o.id")
          .select(eb.fn.countAll<number>().as("c"))
          .as("item_count"),
      );
    if (receiptGroupId) {
      rows = rows.where(sql<boolean>`o.metadata->>'receipt_group_id' = ${receiptGroupId}`);
    }
    if (cursor) {
      rows = rows.where(sql<boolean>`(${orderDay}, o.created_at, o.id) < (${cursor.d}::date, ${cursor.c}::timestamptz, ${cursor.id}::uuid)`);
    }
    const page = await rows
      .orderBy(orderDay, "desc")
      .orderBy("o.created_at", "desc")
      .orderBy("o.id", "desc")
      .limit(limit + 1)
      .execute();
    const more = page.length > limit;
    const items = (more ? page.slice(0, limit) : page).map(({ sort_day, sort_created, ...o }) => ({ ...o, _day: sort_day, _created: sort_created }));
    const last = items[items.length - 1];
    const next_cursor =
      more && last
        ? encodeCursor({
            d: String(last._day),
            c: String(last._created),
            id: String(last.id),
          })
        : null;
    res.json({ items: await orderFigures(tenantContext(req).org.id, tenantDb(req), items.map(({ _day, _created, ...o }) => o)), next_cursor });
  }),
);

// AI-REACH: exempt — the figures above the orders list; Cobb reads and counts orders through the list itself.
// The figures above the list, over every order the filters match, not the
// page loaded: how many, how many still coming, what was spent (orderTotal:
// the stated total, else the lines), by month for the last six and by vendor.
ordersRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const { q } = filteredOrders(req);
    const orgId = tenantContext(req).org.id;
    const rows = await orderFigures(orgId, tenantDb(req), await q.selectAll("o").execute());
    const currency = await platform().money.currency(orgId);
    const sum = combineOrderTotals(rows.map((o) => o.money_total), currency);
    const byMonth = new Map<string, number>();
    const byVendor = new Map<string, number>();
    const from = new Date(); from.setUTCMonth(from.getUTCMonth() - 5, 1);
    const firstMonth = from.toISOString().slice(0, 7);
    for (const o of rows) {
      const month = String(o.ordered_at || o.created_at).slice(0, 7);
      const date = o.ordered_at || o.created_at;
      const key = date instanceof Date ? date.toISOString().slice(0, 7) : month;
      if (key >= firstMonth) byMonth.set(key, (byMonth.get(key) || 0) + o.money_total.amount);
      byVendor.set(o.vendor || "", (byVendor.get(o.vendor || "") || 0) + o.money_total.amount);
    }
    res.json({
      count: rows.length,
      open: rows.filter((o) => ["planned", "ordered", "in-transit"].includes(o.status)).length,
      in_transit: rows.filter((o) => o.status === "in-transit").length,
      from_receipts: rows.filter((o) => "receipt_file_id" in o.metadata).length,
      spend: sum.amount, money_total: sum, currency,
      priced: rows.filter((o) => o.total !== null && o.unpriced_lines === 0).length,
      by_month: [...byMonth].map(([month, spend]) => ({ month, spend })),
      top_vendors: [...byVendor].filter(([, spend]) => spend > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([vendor, spend]) => ({ vendor: vendor || null, spend })),
    });
  }),
);

ordersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const order = await db
      .selectFrom("purchases_orders as o")
      .selectAll("o")
      .select(orderTotal("o").as("total"))
      .where("o.id", "=", id)
      .where("o.instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!order) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    const items = await db
      .selectFrom("purchases_order_items")
      .selectAll()
      .where("order_id", "=", id)
      .orderBy("created_at")
      .execute();
    const [priced] = await orderFigures(tenantContext(req).org.id, db, [order]);
    // The parcels it ships in, when more than one (#5351); a line names its
    // own by shipment_id.
    const shipments = await withCarrierNames(tenantContext(req).org.id, await listShipments(db, id));
    // The store's own order page, when an order email carried it (#5461):
    // which store and how following it is going. Never the link.
    const order_page = await orderPageSummary(db, id);
    res.json({ ...priced, shipments, order_page, items: items.map((i) => ({ ...i, currency: fieldCurrency(i.metadata, "unit_cost", priced!.currency) })) });
  }),
);

ordersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, ORDER_NATIVE_KEYS, "purchases:order");
    const routed = routeUnknownToMetadata(req.body, ORDER_NATIVE_KEYS);
    const parsed = OrderCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    // Dual-write the legacy `vendor` text from the linked vendor's name so
    // cross-module readers + the orders list stay correct without a join.
    const vendorText = await vendorTextFor(req, parsed.data.vendor_id, parsed.data.vendor);
    const main = await platform().money.currency(ctx.org.id);
    const orderMetadata = Object.assign({}, parsed.data.metadata, { currency: fieldCurrency(parsed.data.metadata, "total_cost", main) });
    const inserted = await db
      .insertInto("purchases_orders")
      .values({
        ...parsed.data,
        vendor: vendorText,
        instance: instanceOf(req),
        status: parsed.data.status ?? "ordered",
        metadata: orderMetadata,
        // An order born with a tracking number is owned by whoever placed it —
        // the arrival sweep interrupts them alone (parcelAudience). Orders
        // recorded no creator at all, so this is their only ownership signal.
        ...(parsed.data.tracking_number ? { tracking_added_by_user_id: session.id } : {}),
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "order_created",
      ref: { module: "purchases", entityType: "order", entityId: inserted.id },
      diff: { vendor: parsed.data.vendor, status: inserted.status },
    });
    platform().events.emit("purchases.order.created", {
      orgId: ctx.org.id,
      orderId: inserted.id,
    });
    // An order email filed before this order existed may have left its
    // store page waiting on this number.
    if (inserted.order_number) await attachWaiting(db, ctx.org.id).catch((err: unknown) => console.error("[purchases] order page attach failed:", (err as Error).name));
    res.status(201).json(inserted);
  }),
);

ordersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    await refuseUnknownFields(req, req.body, ORDER_NATIVE_KEYS, "purchases:order");
    const routed = routeUnknownToMetadata(req.body, ORDER_NATIVE_KEYS);
    const parsed = OrderUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const before = await db
      .selectFrom("purchases_orders")
      .select(["status"])
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    // Keep the legacy `vendor` text in sync when vendor_id changes in this PATCH.
    // Custom fields MERGE into the live row (withMetadataMerged, #3625).
    const patch: Record<string, unknown> = withMetadataMerged({ ...parsed.data, updated_at: new Date() } as Record<string, unknown>);
    // Setting a tracking number claims the parcel; clearing it releases the
    // claim. An edit that does not touch tracking leaves ownership alone.
    if ("tracking_number" in parsed.data) {
      patch.tracking_added_by_user_id = parsed.data.tracking_number ? session.id : null;
    }
    if ("vendor_id" in parsed.data) {
      const vt = await vendorTextFor(req, parsed.data.vendor_id, parsed.data.vendor);
      if (vt !== undefined) patch.vendor = vt;
    }
    const updated = await db
      .updateTable("purchases_orders")
      .set(patch as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirstOrThrow();
    // One way: the order is evidence for what it bought, so a changed vendor
    // or date reaches the things it bought, never over what a person typed.
    if ("vendor" in parsed.data || "vendor_id" in parsed.data || "ordered_at" in parsed.data) {
      await stampLine(db, ctx.org.id, id).catch(() => 0);
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "order_updated",
      ref: { module: "purchases", entityType: "order", entityId: id },
      diff: parsed.data,
      before,
    });
    if (parsed.data.status && parsed.data.status !== before.status) {
      platform().events.emit("purchases.order.status_changed", {
        orgId: ctx.org.id,
        orderId: id,
        from: before.status,
        to: parsed.data.status,
      });
      if (parsed.data.status === "arrived") {
        await platform().events.emit("purchases.order.arrived", {
          orgId: ctx.org.id,
          orderId: id,
        });
        // The lines not yet received are received now: stamped once, then
        // told to the stock and spend wires (receive.ts, the one door).
        const at = updated.arrived_at as Date | string | null;
        const on = at instanceof Date ? at.toISOString().slice(0, 10) : at ? String(at).slice(0, 10) : arrivedEverywhere(new Date());
        await receiveOrderLines(db, ctx.org.id, id, on);
      }
    }
    res.json(updated);
  }),
);

ordersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    // An order is a record of money spent: removing it, lines and all, is an
    // owner's or admin's, the same as deleting a part in Inventory. A member
    // corrects or removes a line instead.
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("purchases_orders")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "order_deleted",
      ref: { module: "purchases", entityType: "order", entityId: id },
    });
    res.status(204).end();
  }),
);

// ── items (nested under /orders/:id/items) ───────────────────────

// AI-ACTION: purchases:add-line
ordersRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "purchases:add-line"))) return;
    const orderId = req.params.id;
    if (!orderId) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const routed = routeUnknownToMetadata(req.body, ITEM_NATIVE_KEYS);
    const parsed = ItemCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const orderCurrency = await db.selectFrom("purchases_orders").select("metadata").where("id", "=", orderId).executeTakeFirstOrThrow();
    const main = await platform().money.currency(ctx.org.id);
    const lineMetadata = Object.assign({}, parsed.data.metadata, { currency: fieldCurrency(parsed.data.metadata, "unit_cost", fieldCurrency(orderCurrency.metadata, "total_cost", main)) });
    const { subject_kind, subject_id, add_to_stock, ...lineFields } = parsed.data;
    let inserted = await db
      .insertInto("purchases_order_items")
      .values({
        ...lineFields,
        part_id: null,
        order_id: orderId,
        metadata: lineMetadata,
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    const subject = subject_kind && subject_id ? { kind: subject_kind, id: subject_id } : parsed.data.part_id ? { kind: "inventory:part", id: parsed.data.part_id } : null;
    if (subject) {
      inserted = ((await claimLine({ db, orgId: ctx.org.id, userId: session.id, orderId, itemId: inserted.id, subject })) ?? inserted) as typeof inserted;
    }
    // Added to an order that already arrived: it arrived with it.
    await receiveIfArrived(db, ctx.org.id, orderId, add_to_stock);
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "order_item_added",
      ref: { module: "purchases", entityType: "order_item", entityId: inserted.id },
      diff: {
        order_id: orderId,
        part_id: parsed.data.part_id,
        qty: parsed.data.qty,
      },
    });
    res.status(201).json(inserted);
  }),
);

ordersRouter.get(
  "/:id/items",
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    if (!orderId) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const items = await db
      .selectFrom("purchases_order_items")
      .selectAll()
      .where("order_id", "=", orderId)
      .orderBy("created_at")
      .execute();
    res.json({ items });
  }),
);

/** A line's own figures, as a person corrects them on the order. */
const ItemEdit = z
  .object({
    description: z.string().max(500).nullable().optional(),
    qty: z.number().positive().optional(),
    unit_cost: z.number().min(0).nullable().optional(),
    currency: z.string().refine(isCurrency).optional(),
  })
  .strict();
const CLAIM_KEYS = new Set(["part_id", "subject_kind", "subject_id"]);

const ItemClaim = z.union([
  z.object({ part_id: z.string().uuid().nullable() }),
  z.object({ subject_kind: z.string().min(1).max(80), subject_id: z.string().min(1).max(120) }),
  z.object({ subject_kind: z.null(), subject_id: z.null() }),
]);

// Claim, or release, one line of an order for what it bought (any record).
//
// A receipt's order is born when the receipt is read, with one line per parsed
// item and part_id NULL on every one - a line on a receipt is not a thing you
// own until somebody files it (docs/design-decisions/order-at-parse.md). Filing
// is what claims a line, by setting part_id; sending the item back releases it.
// Until this existed the only way to link a part was to ADD a line, which is
// how every order confirmed through the old inbox panel came to carry each
// line twice - once from parse with no part, once from confirm with one
// (measured 2026-09-06: "Croissant qty 2" listed twice on one order).
//
// AI-REACH: exempt — internal reconciliation surface for the scan inbox's
// confirm/unconfirm, not a user or Cobb action (a person edits an order via
// the order UI, not this endpoint).
ordersRouter.patch(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    const itemId = req.params.itemId;
    if (!orderId || !itemId) {
      res.status(400).json({ error: { code: "missing_id", message: "order id and item id required" } });
      return;
    }
    // Two things this edit may carry: the line's own figures (what it is, how
    // many, the price), and what it bought (the claim). Either or both; a
    // figure-only edit never touches the link.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const claimBody = Object.fromEntries(Object.entries(body).filter(([k]) => CLAIM_KEYS.has(k)));
    const edit = ItemEdit.safeParse(Object.fromEntries(Object.entries(body).filter(([k]) => !CLAIM_KEYS.has(k))));
    if (!edit.success) return badBody(res, edit.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    if (Object.keys(edit.data).length > 0) {
      const r = await editOrderLine(db, { orgId: ctx.org.id, userId: session.id }, itemId, edit.data, orderId);
      if (!r.ok) {
        res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
        return;
      }
      const edited = r.line;
      if (Object.keys(claimBody).length === 0) {
        res.json(edited);
        return;
      }
    }
    const parsed = ItemClaim.safeParse(claimBody);
    if (!parsed.success) return badBody(res, parsed.error);
    // Any record, not only a part: a printer bought on a marketplace is a
    // machine. `part_id` alone still means a part.
    const d = parsed.data as { part_id?: string | null; subject_kind?: string | null; subject_id?: string | null };
    const subject = d.subject_kind && d.subject_id ? { kind: d.subject_kind, id: d.subject_id } : d.part_id ? { kind: "inventory:part", id: d.part_id } : null;
    const updated = await claimLine({ db, orgId: ctx.org.id, userId: session.id, orderId, itemId, subject });
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "order line not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: subject ? "order_item_claimed" : "order_item_released",
      ref: { module: "purchases", entityType: "order_item", entityId: itemId },
      diff: { order_id: orderId, subject_kind: subject?.kind ?? null, subject_id: subject?.id ?? null },
    });
    res.json(updated);
  }),
);

// How many of a line's units are in hand, counted one by one (#5734): each
// scan of a spool of ten that fills one of its line's slots in the scan
// inbox. The tenth receives the line (setReceivedCount).
// AI-REACH: exempt — the scan inbox's slot count reports here; the assistant counts a unit through fill_order_line, which calls this
// UI-REACH: the scan inbox reports each unit a person scans in on the line (OrderLineUnits); no screen sets a count by hand
ordersRouter.post(
  "/:id/items/:itemId/received",
  asyncHandler(async (req, res) => {
    const body = z.object({ received: z.number().int().min(0).max(100_000) }).safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const line = await db.selectFrom("purchases_order_items").select("id").where("id", "=", req.params.itemId ?? "").where("order_id", "=", req.params.id ?? "").executeTakeFirst();
    if (!line) {
      res.status(404).json({ error: { code: "not_found", message: "order line not found" } });
      return;
    }
    const r = await setReceivedCount(db, ctx.org.id, line.id, body.data.received, arrivedEverywhere(new Date()));
    res.json(r);
  }),
);

// Remove one line item from an order. Used when a receipt-created part is
// sent back to the scan inbox (unconfirm): its line item must go too, else the
// order is left with a row pointing at a now-deleted part (part_id has no FK
// cascade). Returns whether the order still has any items left, so the caller
// can drop a now-empty order in the same flow.
// Also the order's own Remove on a line. A line already received leaves its
// stock where it is: the order is a record of the purchase, the item's count
// is the shelf.
// AI-REACH: exempt — Cobb removes a line through purchases:remove-line; this
// route is the order page's and scan-undo's.
ordersRouter.delete(
  "/:id/items/:itemId",
  asyncHandler(async (req, res) => {
    const orderId = req.params.id;
    const itemId = req.params.itemId;
    if (!orderId || !itemId) {
      res.status(400).json({ error: { code: "missing_id", message: "id + itemId required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("purchases_order_items")
      .where("id", "=", itemId)
      .where("order_id", "=", orderId)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "order item not found" } });
      return;
    }
    const remaining = await db
      .selectFrom("purchases_order_items")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("order_id", "=", orderId)
      .executeTakeFirst();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "order_item_removed",
      ref: { module: "purchases", entityType: "order_item", entityId: itemId },
      diff: { order_id: orderId },
    });
    res.json({ deleted: itemId, items_remaining: Number(remaining?.n ?? 0) });
  }),
);

// silence unused-import (kept for future cost-rollup queries)
void sql;
