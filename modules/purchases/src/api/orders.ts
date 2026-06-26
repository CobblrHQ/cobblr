// /orders — REST for purchases orders + the nested /items collection.
// A 'status' transition to 'arrived' emits purchases.order.arrived
// so downstream wires (e.g. bump inventory stock) can react.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

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
  tracking_number: z.string().max(160).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const OrderUpdate = OrderCreate.partial();

const ItemCreate = z.object({
  part_id: z.string().uuid().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  qty: z.number(),
  unit_cost: z.number().nullable().optional(),
  consumed_by_module: z.string().max(80).nullable().optional(),
  consumed_by_entity_type: z.string().max(80).nullable().optional(),
  consumed_by_entity_id: z.string().uuid().nullable().optional(),
  received_at: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// D6: top-level keys the schemas know about. Anything else the caller
// POSTs gets hoisted into metadata by routeUnknownToMetadata().
const ORDER_NATIVE_KEYS = new Set(Object.keys(OrderCreate.shape));
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

ordersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("purchases_orders")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("ordered_at", "desc")
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();
    res.json({ items });
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
      .selectFrom("purchases_orders")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
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
    res.json({ ...order, items });
  }),
);

ordersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, ORDER_NATIVE_KEYS);
    const parsed = OrderCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    // Dual-write the legacy `vendor` text from the linked vendor's name so
    // cross-module readers + the orders list stay correct without a join.
    const vendorText = await vendorTextFor(req, parsed.data.vendor_id, parsed.data.vendor);
    const inserted = await db
      .insertInto("purchases_orders")
      .values({
        ...parsed.data,
        vendor: vendorText,
        instance: instanceOf(req),
        status: parsed.data.status ?? "ordered",
        metadata: parsed.data.metadata ?? {},
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
    const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date() };
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
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "order_updated",
      ref: { module: "purchases", entityType: "order", entityId: id },
      diff: parsed.data,
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
        // Fan one event per order_item that's mapped to an
        // inventory part. Lets a wire bind purchases.order_item
        // .received → inventory.adjust-stock for auto-bump-on-
        // arrival without needing the wire engine to iterate
        // collections itself (D9 from BACKLOG).
        const items = await db
          .selectFrom("purchases_order_items")
          .select(["id", "part_id", "qty", "unit_cost", "description"])
          .where("order_id", "=", id)
          .where("part_id", "is not", null)
          .execute();
        for (const it of items) {
          if (!it.part_id) continue;
          const qty = Number(it.qty);
          const unitCost = it.unit_cost == null ? null : Number(it.unit_cost);
          await platform().events.emit("purchases.order_item.received", {
            orgId: ctx.org.id,
            orderId: id,
            orderItemId: it.id,
            partId: it.part_id,
            delta: qty,
            // Cost fields let a bundle wire log spend into a metric (e.g. a
            // "Grocery spend" trend) without coupling purchases to anything.
            unitCost,
            lineCost: unitCost == null ? null : Number((unitCost * qty).toFixed(2)),
            reason: `Order arrived (${it.description ?? "item"})`,
          });
        }
      }
    }
    res.json(updated);
  }),
);

ordersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
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

ordersRouter.post(
  "/:id/items",
  asyncHandler(async (req, res) => {
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
    const inserted = await db
      .insertInto("purchases_order_items")
      .values({
        ...parsed.data,
        order_id: orderId,
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
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

// silence unused-import (kept for future cost-rollup queries)
void sql;
