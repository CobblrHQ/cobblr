// /items — line items across orders, and the price history of one thing.
//
// The nested /orders/:id/items collection answers "what was on this order".
// This answers the other direction: "every time I bought THIS, what did it
// cost" — the query behind the part-detail price panel, and the module's
// declared `listEndpoint` for purchases:order_item.
//
// Why its own route rather than the generic /entities/:kind list: unit_cost is
// deliberately NOT in the kind's exposableFields (costs stay private to the
// owning module), so the projected cross-module list can never carry the one
// number this is about. A module's own route is the sanctioned way to serve
// its full-fat rows under its own role gating.
//
// Cross-INSTANCE on purpose: a part's price history is the history of that
// part, whichever purchasing instance the order was filed under.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";
import { summarizePriceHistory, type PricePoint } from "../price-stats.js";

export const itemsRouter = Router({ mergeParams: true });

const Query = z.object({
  part_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** numeric columns arrive as strings from pg; null stays null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDay(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

itemsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_query", message: "Bad query", details: parsed.error.issues },
      });
      return;
    }
    const { part_id, order_id, limit } = parsed.data;
    if (!part_id && !order_id) {
      res.status(400).json({
        error: { code: "invalid_query", message: "part_id or order_id is required" },
      });
      return;
    }

    const db = tenantDb(req);
    // The date money actually changed hands. A receipt-imported line carries no
    // received_at (the receipt IS the receipt), so fall back to the order's
    // arrived_at / ordered_at before giving up and using the row's created_at.
    const purchasedAt = sql<Date | null>`coalesce(i.received_at, o.arrived_at, o.ordered_at, i.created_at::date)`;

    let q = db
      .selectFrom("purchases_order_items as i")
      .innerJoin("purchases_orders as o", "o.id", "i.order_id")
      .select([
        "i.id",
        "i.order_id",
        "i.part_id",
        "i.description",
        "i.qty",
        "i.unit_cost",
        "i.received_at",
        "i.created_at",
        "o.vendor",
        "o.order_number",
        "o.status as order_status",
      ])
      .select(purchasedAt.as("purchased_at"))
      // A cancelled order was never paid for — counting it as a price would
      // report a change that never happened.
      .where("o.status", "!=", "cancelled");

    if (part_id) q = q.where("i.part_id", "=", part_id);
    if (order_id) q = q.where("i.order_id", "=", order_id);

    // Newest-first so `limit` keeps the RECENT history (the part of it a price
    // trend is about); the response is reversed back to oldest-first below.
    const rows = await q
      .orderBy(purchasedAt, "desc")
      .orderBy("i.created_at", "desc")
      .limit(limit)
      .execute();

    const items: PricePoint[] = rows
      .map((r) => ({
        id: r.id,
        order_id: r.order_id,
        order_number: r.order_number,
        vendor: r.vendor,
        purchased_at: isoDay(r.purchased_at),
        description: r.description,
        qty: num(r.qty) ?? 1,
        unit_cost: num(r.unit_cost),
      }))
      .reverse();

    res.json({
      part_id: part_id ?? null,
      items,
      stats: summarizePriceHistory(items),
    });
  }),
);
