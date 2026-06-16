// /vendors — purchasing-depth: vendors as a managed entity (was free text on
// each order). CRUD + a per-vendor order-count + total-spend rollup, and the
// "orders from this vendor" list. Orders link via orders.vendor_id; the legacy
// orders.vendor text is dual-written from the vendor name (see orders.ts) so
// cross-module readers + pre-vendor rows keep working.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const vendorsRouter = Router({ mergeParams: true });

const VendorCreate = z.object({
  name: z.string().min(1).max(200),
  website: z.string().url().max(500).nullable().optional(),
  account_number: z.string().max(160).nullable().optional(),
  contact: z.string().max(500).nullable().optional(),
  lead_time_days: z.number().int().nonnegative().max(3650).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const VendorUpdate = VendorCreate.partial();
const VENDOR_NATIVE_KEYS = new Set(Object.keys(VendorCreate.shape));

// List with rollup: order_count + total_spend (total_cost over that vendor's orders).
vendorsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("purchases_vendors as v")
      .where("v.instance", "=", instanceOf(req))
      .select((eb) => [
        "v.id", "v.name", "v.website", "v.account_number", "v.contact",
        "v.lead_time_days", "v.notes", "v.metadata", "v.created_at", "v.updated_at",
        eb.selectFrom("purchases_orders as o").select(eb.fn.countAll().as("c"))
          .whereRef("o.vendor_id", "=", "v.id").as("order_count"),
        eb.selectFrom("purchases_orders as o").select(sql<string>`coalesce(sum(o.total_cost), 0)`.as("s"))
          .whereRef("o.vendor_id", "=", "v.id").as("total_spend"),
      ])
      .orderBy("v.name")
      .execute();
    res.json({
      items: items.map((v) => ({
        ...v,
        order_count: Number(v.order_count ?? 0),
        total_spend: Number(v.total_spend ?? 0),
      })),
    });
  }),
);

vendorsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const db = tenantDb(req);
    const vendor = await db
      .selectFrom("purchases_vendors")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!vendor) {
      res.status(404).json({ error: { code: "not_found", message: "vendor not found" } });
      return;
    }
    const orders = await db
      .selectFrom("purchases_orders")
      .select(["id", "order_number", "status", "ordered_at", "expected_arrival", "arrived_at", "total_cost"])
      .where("vendor_id", "=", id)
      .where("instance", "=", instanceOf(req))
      .orderBy("ordered_at", "desc")
      .execute();
    const total_spend = orders.reduce((sum, o) => sum + (Number(o.total_cost) || 0), 0);
    res.json({ ...vendor, orders, order_count: orders.length, total_spend });
  }),
);

vendorsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, VENDOR_NATIVE_KEYS);
    const parsed = VendorCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const inserted = await db
      .insertInto("purchases_vendors")
      .values({ ...parsed.data, instance: instanceOf(req), metadata: parsed.data.metadata ?? {} } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "vendor_created",
      ref: { module: "purchases", entityType: "vendor", entityId: inserted.id },
      diff: { name: inserted.name },
    });
    platform().events.emit("purchases.vendor.created", { orgId: ctx.org.id, vendorId: inserted.id });
    res.status(201).json(inserted);
  }),
);

vendorsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const routed = routeUnknownToMetadata(req.body, VENDOR_NATIVE_KEYS);
    const parsed = VendorUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const updated = await db
      .updateTable("purchases_vendors")
      .set({ ...parsed.data, updated_at: new Date() } as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "vendor not found" } });
      return;
    }
    // Renaming a vendor re-syncs the legacy `vendor` text on its linked orders
    // so cross-module readers + the orders list stay consistent.
    if (parsed.data.name) {
      await db
        .updateTable("purchases_orders")
        .set({ vendor: parsed.data.name })
        .where("vendor_id", "=", id)
        .where("instance", "=", instanceOf(req))
        .execute();
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "vendor_updated",
      ref: { module: "purchases", entityType: "vendor", entityId: id },
      diff: parsed.data,
    });
    res.json(updated);
  }),
);

vendorsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    // orders.vendor_id → null via the FK (on delete set null); the legacy
    // `vendor` text on those orders is left intact so they still read sensibly.
    const deleted = await db
      .deleteFrom("purchases_vendors")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "vendor not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "vendor_deleted",
      ref: { module: "purchases", entityType: "vendor", entityId: id },
      diff: {},
    });
    res.status(204).end();
  }),
);
