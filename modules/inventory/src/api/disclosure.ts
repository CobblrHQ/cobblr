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
//   3. The sticky LATCH — config.stock_latched. Once the instance has shown
//      stock signal (bundle-declared at install, or the data probe below firing
//      once), the platform writes stock_latched:true meta-side. A latched
//      instance stays stock without re-probing, so it does NOT flip back to lean
//      when its quantities drain to zero (the drain-to-restock trap) and
//      instance-kind synthesis can read the verdict without a tenant pool.
//   4. Stock-shaped data — any record in the instance carrying a non-zero qty,
//      a reorder point (min_qty), or a non-"each" unit (a measured unit only
//      exists to be depleted). `cost` is NOT signal: a catalog recording what a
//      book cost implies nothing about stock, and would wrongly latch the whole
//      shelf. On the first fire this SETS the latch (§3 above) so the verdict is
//      then answered meta-side.
//
// Bias lean: absent any signal the instance is a catalog. The disclosure is
// non-destructive on both sides — hiding the stock panels never drops qty/cost,
// revealing them never fills anything in.

import type { Request, Response } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { asyncHandler } from "./util.js";
import { tenantDb, instanceOf, tenantContext } from "../db.js";

export interface Disclosure {
  stock: boolean;
  instance: string;
  source: "override" | "default" | "latched" | "data" | "lean";
}

/** True when a record's field bag carries stock signal (a measured/depleting
 *  shape): a non-zero qty, a reorder point, or a non-"each" unit. Shared by the
 *  disclosure probe (SQL, below) and the parts-create latch (route code) so the
 *  two can never disagree on what "stock-shaped" means. `cost` is deliberately
 *  excluded — see the header. */
export function fieldsShowStockSignal(row: {
  qty?: number | string | null;
  min_qty?: number | string | null;
  unit?: string | null;
}): boolean {
  const qty = row.qty == null ? 0 : Number(row.qty);
  const unit = (row.unit ?? "").trim();
  return (Number.isFinite(qty) && qty !== 0) || row.min_qty != null || (unit !== "" && unit !== "each");
}

/** Latch this instance to stock meta-side (idempotent; only call when not
 *  already latched). Best-effort — a latch write must never fail the request it
 *  rides on. Exported so the parts-create path can latch on a stock-shaped write
 *  without waiting for someone to open the list. */
export async function latchInstanceStock(orgId: string, instance: string): Promise<void> {
  try {
    await platform().instances.patchDerivedConfig(orgId, "inventory", instance, {
      stock_latched: true,
    });
  } catch (err) {
    console.error(`[inventory.disclosure] latch write for ${instance} failed:`, (err as Error).message);
  }
}

// GET .../disclosure — reachable both instance-scoped
// (/instances/:name/items/disclosure, where req.instance + req.instanceConfig
// carry the per-instance override) and on the default parts route
// (/modules/inventory/parts/disclosure, the default instance = always stock).
export const disclosureHandler = asyncHandler(async (req: Request, res: Response) => {
  // The route's OWN instance only — a `?instance=` override used to be accepted
  // here, but it read req.instanceConfig (the route's config, not the queried
  // instance's), silently bypassing the user override and the latch. No caller
  // ever used it; removed rather than half-fixed.
  const instance = instanceOf(req);

  const cfg = (req as unknown as { instanceConfig?: Record<string, unknown> }).instanceConfig;

  // 1. Explicit override wins — the sticky one-tap toggle, stored on the
  //    instance's entity_kind_overrides.config.stock and merged into
  //    req.instanceConfig by the platform's resolveInstance middleware.
  const override = cfg?.stock;
  if (typeof override === "boolean") {
    res.json({ stock: override, instance, source: "override" } satisfies Disclosure);
    return;
  }

  // 2. The default instance is always stock.
  if (instance === "inventory") {
    res.json({ stock: true, instance, source: "default" } satisfies Disclosure);
    return;
  }

  // 3. Already latched — answer meta-side, no probe. Keeps a drained stock
  //    instance from flipping back to lean.
  if (cfg?.stock_latched === true) {
    res.json({ stock: true, instance, source: "latched" } satisfies Disclosure);
    return;
  }

  // 4. Stock-shaped data present? On the first fire, latch it so this becomes a
  //    meta-side answer thereafter (and so combine/scan see the right traits).
  const db = tenantDb(req);
  const probe = await sql<{ has_stock: boolean }>`
    select exists (
      select 1
      from inventory_parts
      where instance = ${instance}
        and (
          qty <> 0
          or min_qty is not null
          or (unit is not null and unit <> 'each')
        )
    ) as has_stock
  `.execute(db);
  const hasStock = probe.rows[0]?.has_stock ?? false;
  if (hasStock) {
    await latchInstanceStock(tenantContext(req).org.id, instance);
  }
  res.json({
    stock: hasStock,
    instance,
    source: hasStock ? "data" : "lean",
  } satisfies Disclosure);
});
