// Entity-kind resolvers — the in-process bridge between
// platform.entities.lookup() and our tenant tables. Other modules
// (and the platform itself) call platform().entities.lookup(orgId,
// "inventory:part", id) and the platform routes here.

import { sql, type Kysely } from "kysely";
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

  // List resolver — lets core-views (and future search) iterate the
  // kind without each consumer learning the inventory_parts table
  // shape. Supports limit/offset, optional free-text q on name +
  // description, and three filter dialects:
  //   filter.<top-level col>  → WHERE col = value          (native)
  //   filter._tag             → join through tags (D7)
  //   filter.<anything else>  → WHERE metadata ->> key = value (D8)
  platform().entities.registerListResolver("inventory:part", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    const NATIVE_FILTER_COLS = new Set(["category_id", "location_id", "state"]);
    let q = db.selectFrom("inventory_parts").selectAll();
    if (query.q && query.q.length > 0) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(eb.fn("lower", ["name"]), "like", needle),
          eb(eb.fn("lower", ["description"]), "like", needle),
        ]),
      );
    }
    if (query.filter) {
      const f = query.filter;
      for (const [key, val] of Object.entries(f)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          // D7: every entity carrying this tag (by name). Case-insensitive
          // match against core_tags_tags.name; sub-query joins assignments.
          const tagName = String(val).trim().toLowerCase();
          q = q.where(
            sql<boolean>`exists (
              select 1 from core_tags_assignments a
              join core_tags_tags t on t.id = a.tag_id
              where a.source_module = 'inventory'
                and a.source_type = 'part'
                and a.source_id = inventory_parts.id
                and lower(t.name) = ${tagName}
            )`,
          );
          continue;
        }
        if (NATIVE_FILTER_COLS.has(key)) {
          if (typeof val === "string") {
            q = q.where(key as never, "=", val as never);
          }
          continue;
        }
        // D8: unknown filter key — assume it's a metadata field.
        // Postgres ->> returns text; we coerce val to string for the
        // comparison. JSON values are stored as their JSON form
        // (numbers come back as text representations).
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates. Native columns only (numeric +
    // date). Unknown col / unsupported (col, op) silently skipped.
    if (query.where) {
      const COMPARABLE = new Set(["qty", "min_qty", "cost", "created_at", "updated_at"]);
      for (const p of query.where) {
        if (!COMPARABLE.has(p.col)) continue;
        if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) continue;
        if (p.ref_col) {
          if (!COMPARABLE.has(p.ref_col)) continue;
          q = q.where(
            sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${sql.ref(p.ref_col)}`,
          );
        } else if (p.value !== undefined) {
          const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
          q = q.where(sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${v}`);
        }
      }
    }
    // Sort: default by name asc. Whitelist sortable columns so a
    // bad config can't blow up the query.
    const sortable = new Set(["name", "qty", "created_at", "updated_at"]);
    const sortSpecs = (query.sort ?? ["name"]).filter((s) =>
      sortable.has(s.replace(/^-/, "")),
    );
    let sortedQ = q;
    for (const spec of sortSpecs) {
      const desc = spec.startsWith("-");
      const col = spec.replace(/^-/, "");
      sortedQ = sortedQ.orderBy(col as never, desc ? "desc" : "asc");
    }
    const rows = await sortedQ.limit(limit).offset(offset).execute();
    return {
      items: rows.map((r) => toResolvedPart(r)),
    };
  });
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
