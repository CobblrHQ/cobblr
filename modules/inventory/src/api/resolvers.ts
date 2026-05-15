// Entity-kind resolvers — the in-process bridge between
// platform.entities.lookup() and our tenant tables. Other modules
// (and the platform itself) call platform().entities.lookup(orgId,
// "inventory:part", id) and the platform routes here.

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

export function registerInventoryResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver(
    "inventory:part",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toResolvedPart(row);
    },
  );

  platform().entities.registerResolver(
    "inventory:location",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_locations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        kind: "inventory:location",
        id: row.id,
        title: row.short_name ?? row.name,
        subtitle: row.kind,
        detailUrl: undefined,
        fields: {
          name: row.name,
          short_name: row.short_name,
          kind: row.kind,
          parent_id: row.parent_id,
        },
      };
    },
  );
}

function toResolvedPart(row: {
  id: string;
  name: string;
  description: string | null;
  qty: string;
  unit: string;
  cost: string | null;
  min_qty: string | null;
  manufacturer: string | null;
  supplier_url: string | null;
  image_path: string | null;
  notes: string | null;
  metadata: unknown;
}): ResolvedEntity {
  const qty = Number(row.qty);
  return {
    kind: "inventory:part",
    id: row.id,
    title: row.name,
    subtitle: row.manufacturer ?? undefined,
    image_path: row.image_path ?? undefined,
    detailUrl: `/inventory/parts/${row.id}`,
    fields: {
      name: row.name,
      description: row.description,
      qty: Number.isFinite(qty) ? qty : 0,
      unit: row.unit,
      cost: row.cost == null ? null : Number(row.cost),
      min_qty: row.min_qty == null ? null : Number(row.min_qty),
      manufacturer: row.manufacturer,
      supplier_url: row.supplier_url,
      image_path: row.image_path,
      notes: row.notes,
      metadata: row.metadata,
    },
  };
}
