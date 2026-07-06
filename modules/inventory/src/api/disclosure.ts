// Per-instance stock-vs-catalog disclosure. Whether an inventory instance
// presents its STOCK face (qty adjuster, cost, supplier, warranty, maintenance,
// allocations, ...) or its LEAN catalog face (title + photo + your fields) is
// DERIVED from signal, not declared. Nobody chooses "collection vs inventory";
// the platform reads what the data is doing. See
// docs/design-decisions/one-record-substrate.md.
//
// Signal, in priority:
//   1. Explicit per-instance override — entity_kind_overrides.config.stock,
//      surfaced on req.instanceConfig by the platform's resolveInstance
//      middleware (the one-tap sticky override; a boolean wins outright).
//   2. The default instance ("inventory") is always stock — it IS the
//      workspace's inventory, never a catalog.
//   3. Stock-shaped data — any record in the instance carrying a non-zero qty,
//      a reorder point (min_qty), a cost, or a non-"each" unit. This catches
//      every real stock instance (filament in grams, yarn in skeins) the moment
//      it holds stock, and leaves a fresh catalog (films, books: qty 0, unit
//      "each", no cost) lean.
//
// Bias lean: absent any signal the instance is a catalog. The disclosure is
// non-destructive on both sides — hiding the stock panels never drops qty/cost,
// revealing them never fills anything in.

import type { Request, Response } from "express";
import { sql } from "kysely";
import { asyncHandler } from "./util.js";
import { tenantDb, instanceOf } from "../db.js";

export interface Disclosure {
  stock: boolean;
  instance: string;
  source: "override" | "default" | "data" | "lean";
}

// GET .../disclosure — reachable both instance-scoped
// (/instances/:name/items/disclosure, where req.instance + req.instanceConfig
// carry the per-instance override) and on the default parts route
// (/modules/inventory/parts/disclosure, the default instance = always stock).
export const disclosureHandler = asyncHandler(async (req: Request, res: Response) => {
  const instance =
    typeof req.query.instance === "string" && req.query.instance.trim()
      ? req.query.instance.trim()
      : instanceOf(req);

  // 1. Explicit override wins — the sticky one-tap toggle, stored on the
  //    instance's entity_kind_overrides.config.stock and merged into
  //    req.instanceConfig by the platform's resolveInstance middleware.
  const override = (req as unknown as { instanceConfig?: Record<string, unknown> })
    .instanceConfig?.stock;
  if (typeof override === "boolean") {
    res.json({ stock: override, instance, source: "override" } satisfies Disclosure);
    return;
  }

  // 2. The default instance is always stock.
  if (instance === "inventory") {
    res.json({ stock: true, instance, source: "default" } satisfies Disclosure);
    return;
  }

  // 3. Stock-shaped data present?
  const db = tenantDb(req);
  const probe = await sql<{ has_stock: boolean }>`
    select exists (
      select 1
      from inventory_parts
      where instance = ${instance}
        and (
          qty <> 0
          or min_qty is not null
          or cost is not null
          or (unit is not null and unit <> 'each')
        )
    ) as has_stock
  `.execute(db);
  const hasStock = probe.rows[0]?.has_stock ?? false;
  res.json({
    stock: hasStock,
    instance,
    source: hasStock ? "data" : "lean",
  } satisfies Disclosure);
});
