// Tier-2 computed-context provider for COMPUTED fields. Rolls up an inventory
// item's child INSTANCES — the parts that point at it via an `instance-of`
// pairing — so a "type" row can surface its stock in a template:
//
//   {{instances.count}}      → 5         (how many physical units of this type)
//   {{instances.total_qty}}  → 3.2       (sum of their qty — e.g. kg remaining)
//   {{instances.in_stock}}   → 4         (units with qty > 0)
//
// Generic: it knows nothing about filament. A "type" is just any inventory:part
// that other parts point at via `instance-of`; a "unit"/instance is a part with
// such a pairing. The kernel invokes this only when a computed template on the
// kind references the `instances` namespace, once per row at resolve time — so
// it costs nothing for plain parts that don't use it.
//
// entity_pairings lives in the META db (keyed by org_id), inventory_parts in the
// TENANT db, so we can't join them — resolve child ids via the pairing surface,
// then aggregate in the tenant db.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

export function registerInventoryComputedContext(): void {
  // NB: `kind` is the PRESENTATION kind — "inventory:part" for the default
  // instance, but "<instance>:item" for a skinned one (e.g. "filament-types:item").
  // Instances are a column on inventory_parts, not a separate kind, and the
  // pairings are always real inventory:part↔inventory:part rows, so we query by
  // the part id regardless of the presentation kind. The engine only invokes
  // this when a computed template references the `instances` namespace, so it's
  // already scoped to the rows (the "type" rows) that opted in.
  platform().entities.registerComputedContext("instances", async (orgId, _kind, id) => {
    let childIds: string[] = [];
    try {
      const pairs = await platform().pairings.findByTargets({
        orgId,
        sourceKind: "inventory:part",
        targetKind: "inventory:part",
        targetIds: [id],
        relationshipKind: "instance-of",
      });
      childIds = pairs.map((p) => p.sourceId);
    } catch {
      return {};
    }
    if (childIds.length === 0) return { count: 0, total_qty: 0, in_stock: 0 };

    try {
      const tdb = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await tdb
        .selectFrom("inventory_parts")
        .select([
          sql<string>`count(*)`.as("count"),
          sql<string>`coalesce(sum(qty), 0)`.as("total_qty"),
          sql<string>`count(*) filter (where qty > 0)`.as("in_stock"),
        ])
        .where("id", "in", childIds)
        .where("archived", "=", false)
        .executeTakeFirst();
      const total = Number(row?.total_qty ?? 0);
      return {
        count: Number(row?.count ?? 0),
        // numeric(12,3) → trim trailing zeros for display (3.200 → 3.2)
        total_qty: Number.isInteger(total) ? total : Number(total.toFixed(3)),
        in_stock: Number(row?.in_stock ?? 0),
      };
    } catch (err) {
      // Tenant table may not exist yet (module mid-provision) — render empty.
      if ((err as Error).message.includes("does not exist")) return {};
      throw err;
    }
  });
}
