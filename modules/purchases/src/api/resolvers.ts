// Platform entity-kind resolvers for purchases. Lets other modules /
// the platform's EntityActionsBar look up an order or order_item by
// (kind, id) without touching the purchases tables directly.

import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { PurchasesDB } from "../db.js";

let registered = false;

export function registerPurchasesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver(
    "purchases:order",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
      const row = await db
        .selectFrom("purchases_orders")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      const resolved: ResolvedEntity = {
        kind: "purchases:order",
        id: row.id,
        title: row.vendor || row.order_number || "(order)",
        subtitle: row.status,
        fields: { ...row, qty: undefined } as Record<string, unknown>,
      };
      return resolved;
    },
  );

  platform().entities.registerResolver(
    "purchases:order_item",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
      const row = await db
        .selectFrom("purchases_order_items")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        kind: "purchases:order_item",
        id: row.id,
        title: row.description ?? "(item)",
        subtitle: `qty ${row.qty}`,
        fields: row as unknown as Record<string, unknown>,
      };
    },
  );
}
