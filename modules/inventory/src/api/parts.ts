// /parts — full CRUD plus the stock-adjust endpoint.
//
// Computed reads (assigned_qty, available_qty, low_stock) come from
// joining inventory_allocations + inventory_parts.min_qty at SELECT
// time. We do not denormalise stock totals; one source of truth is
// the row, and aggregations live in the read query.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const partsRouter = Router({ mergeParams: true });

const PartCreate = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(8_000).nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  qty: z.number().nonnegative().optional(),
  unit: z.string().max(40).optional(),
  cost: z.number().nonnegative().optional(),
  min_qty: z.number().nonnegative().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  supplier_url: z.string().url().max(500).nullable().optional(),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  state: z.enum(["active", "draft", "needs_review"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PartUpdate = PartCreate.partial();

const StockAdjust = z.object({
  delta: z.number(),
  reason: z.string().max(500).optional(),
});

const ListQuery = z.object({
  search: z.string().optional(),
  category_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  state: z.enum(["active", "draft", "needs_review"]).optional(),
  low_stock: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  // Opaque cursor — base64 of {name,id} of the last row on the
  // previous page. Absent = first page.
  cursor: z.string().optional(),
});

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ name, id })).toString("base64url");
}
function decodeCursor(c: string): { name: string; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof o?.name === "string" && typeof o?.id === "string") return o;
  } catch {
    /* malformed cursor — treat as no cursor */
  }
  return null;
}

partsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const filter = q.data;
    const db = tenantDb(req);

    let query = db
      .selectFrom("inventory_parts as p")
      .leftJoin("inventory_categories as c", "c.id", "p.category_id")
      .leftJoin("inventory_locations as l", "l.id", "p.location_id")
      .select((eb) => [
        "p.id",
        "p.name",
        "p.description",
        "p.qty",
        "p.unit",
        "p.cost",
        "p.min_qty",
        "p.manufacturer",
        "p.supplier_url",
        "p.image_path",
        "p.notes",
        "p.state",
        "p.metadata",
        "p.created_at",
        "p.updated_at",
        "p.category_id",
        "c.name as category_name",
        "p.location_id",
        "l.name as location_name",
        // Aggregated reserved quantity from active allocations.
        eb
          .selectFrom("inventory_allocations as a")
          .select(sql<string>`coalesce(sum(a.qty), 0)`.as("v"))
          .whereRef("a.part_id", "=", "p.id")
          .where("a.status", "=", "reserved")
          .as("assigned_qty"),
      ])
      // Stable order: name, then id as tiebreaker (names aren't
      // unique) — required for correct cursor pagination.
      .orderBy("p.name")
      .orderBy("p.id");

    if (filter.search) {
      const like = `%${filter.search.toLowerCase()}%`;
      query = query.where((eb) =>
        eb.or([
          eb(sql<string>`lower(p.name)`, "like", like),
          eb(sql<string>`lower(coalesce(p.notes,''))`, "like", like),
        ]),
      );
    }
    if (filter.category_id) query = query.where("p.category_id", "=", filter.category_id);
    if (filter.location_id) query = query.where("p.location_id", "=", filter.location_id);
    if (filter.state) query = query.where("p.state", "=", filter.state);

    // Cursor: keyset pagination on the (name, id) ordering.
    if (filter.cursor) {
      const c = decodeCursor(filter.cursor);
      if (c) {
        query = query.where(
          sql<boolean>`(p.name, p.id) > (${c.name}, ${c.id})`,
        );
      }
    }

    const lowStockOnly =
      filter.low_stock === "1" || filter.low_stock === "true";

    // low_stock is a post-filter (it depends on the computed
    // available qty). Mixing it with keyset pagination would make
    // next_cursor unreliable, so when it's on we fetch a generous
    // single page — the low-stock subset is inherently small.
    const fetchLimit = lowStockOnly ? 200 : filter.limit + 1;
    const rows = await query.limit(fetchLimit).execute();

    let hasMore = false;
    let pageRows = rows;
    if (!lowStockOnly && rows.length > filter.limit) {
      hasMore = true;
      pageRows = rows.slice(0, filter.limit);
    }

    const items = pageRows.map((r) => {
      const qty = Number(r.qty);
      const assigned = Number(r.assigned_qty ?? 0);
      const minQty = r.min_qty != null ? Number(r.min_qty) : null;
      const available = qty - assigned;
      return {
        ...r,
        qty,
        cost: r.cost == null ? null : Number(r.cost),
        min_qty: minQty,
        assigned_qty: assigned,
        available_qty: available,
        low_stock: minQty != null && available <= minQty,
      };
    });
    const filtered = lowStockOnly
      ? items.filter((p) => p.low_stock)
      : items;

    const last = filtered[filtered.length - 1];
    const next_cursor =
      hasMore && last ? encodeCursor(last.name, last.id) : null;

    res.json({ items: filtered, next_cursor });
  }),
);

partsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const row = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }
    res.json(row);
  }),
);

// D6: top-level keys the PartCreate / PartUpdate schemas know about.
// Derived from the zod schema's shape so they stay in sync. Anything
// not in here that the caller sends gets hoisted into metadata by
// routeUnknownToMetadata().
const NATIVE_PART_KEYS = new Set(Object.keys(PartCreate.shape));

partsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, NATIVE_PART_KEYS);
    const parsed = PartCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const inserted = await db
      .insertInto("inventory_parts")
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        category_id: parsed.data.category_id ?? null,
        location_id: parsed.data.location_id ?? null,
        qty: String(parsed.data.qty ?? 0),
        unit: parsed.data.unit ?? "each",
        cost: parsed.data.cost != null ? String(parsed.data.cost) : null,
        min_qty: parsed.data.min_qty != null ? String(parsed.data.min_qty) : null,
        manufacturer: parsed.data.manufacturer ?? null,
        supplier_url: parsed.data.supplier_url ?? null,
        image_path: parsed.data.image_path ?? null,
        notes: parsed.data.notes ?? null,
        state: parsed.data.state ?? "active",
        metadata: parsed.data.metadata ?? {},
      })
      .returning(["id", "name", "qty", "state", "metadata", "created_at"])
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_created",
      ref: { module: "inventory", entityType: "part", entityId: inserted.id },
      diff: { name: inserted.name, qty: inserted.qty },
    });
    platform().events.emit("inventory.part.created", {
      orgId: ctx.org.id,
      partId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);

partsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, NATIVE_PART_KEYS);
    const parsed = PartUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (k === "qty" || k === "cost" || k === "min_qty") {
        patch[k] = v == null ? null : String(v);
      } else {
        patch[k] = v;
      }
    }
    patch.updated_at = new Date();

    const updated = await db
      .updateTable("inventory_parts")
      .set(patch)
      .where("id", "=", id)
      .returning(["id", "name", "qty", "state", "updated_at"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_updated",
      ref: { module: "inventory", entityType: "part", entityId: updated.id },
      diff: parsed.data,
    });
    platform().events.emit("inventory.part.updated", {
      orgId: ctx.org.id,
      partId: updated.id,
    });

    res.json(updated);
  }),
);

partsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const deleted = await db
      .deleteFrom("inventory_parts")
      .where("id", "=", id)
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "part_deleted",
      ref: { module: "inventory", entityType: "part", entityId: deleted.id },
      diff: { name: deleted.name },
    });
    platform().events.emit("inventory.part.deleted", {
      orgId: ctx.org.id,
      partId: deleted.id,
    });

    res.status(204).end();
  }),
);

partsRouter.post(
  "/:id/stock-adjust",
  asyncHandler(async (req, res) => {
    const parsed = StockAdjust.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${String(parsed.data.delta)}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returning(["id", "name", "qty"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "part not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "stock_adjusted",
      ref: { module: "inventory", entityType: "part", entityId: updated.id },
      diff: { delta: parsed.data.delta, reason: parsed.data.reason ?? null, new_qty: updated.qty },
    });
    // Await so any wires (e.g. "flip task deps that depended on
    // this part") have run before the client gets its 200. A client
    // that immediately re-reads the task sees satisfied=true.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.org.id,
      partId: updated.id,
      delta: parsed.data.delta,
      newQty: Number(updated.qty),
    });

    res.json({ ...updated, qty: Number(updated.qty) });
  }),
);
