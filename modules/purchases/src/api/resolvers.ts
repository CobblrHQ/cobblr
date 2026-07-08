// Platform entity-kind resolvers for purchases. Lets other modules /
// the platform's EntityActionsBar look up an order or order_item by
// (kind, id) without touching the purchases tables directly.

import { platform, parseSort, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { PurchasesDB } from "../db.js";

let registered = false;

// Native columns each list resolver will order by. Unknown fields drop out via
// parseSort rather than reaching SQL.
const ORDER_SORTABLE = new Set([
  "status",
  "vendor",
  "order_number",
  "ordered_at",
  "expected_arrival",
  "arrived_at",
  "total_cost",
  "shipping_cost",
  "created_at",
  "updated_at",
]);
const VENDOR_SORTABLE = new Set(["name", "created_at", "updated_at"]);

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

  platform().entities.registerListResolver("purchases:order", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("purchases_orders").selectAll();
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(eb.fn("lower", ["vendor"]), "like", needle),
          eb(eb.fn("lower", ["order_number"]), "like", needle),
        ]),
      );
    }
    if (query.filter) {
      const NATIVE = new Set(["status", "vendor"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'purchases'
              and a.source_type = 'order'
              and a.source_id = purchases_orders.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          if (Array.isArray(val)) {
            const vals = val.filter((v): v is string => typeof v === "string");
            if (vals.length > 0) q = q.where(key as never, "in", vals as never);
          } else if (typeof val === "string") {
            q = q.where(key as never, "=", val as never);
          }
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates on numeric / date columns. Lets a
    // saved view ask "orders overdue" (`expected_arrival <= now`),
    // "expensive orders" (`total_cost >= 100`), etc.
    if (query.where) {
      const COMPARABLE = new Set([
        "ordered_at",
        "expected_arrival",
        "arrived_at",
        "total_cost",
        "shipping_cost",
        "created_at",
        "updated_at",
      ]);
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
    const order = parseSort(query.sort, ORDER_SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (order.length === 0) q = q.orderBy("ordered_at", "desc");
    const rows = await q
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      items: rows.map((row) => ({
        kind: "purchases:order",
        id: row.id,
        title: row.vendor || row.order_number || "(order)",
        subtitle: row.status,
        fields: { ...row } as Record<string, unknown>,
      })),
    };
  });

  // ── vendors ──────────────────────────────────────────────────────
  platform().entities.registerResolver("purchases:vendor", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    const row = await db.selectFrom("purchases_vendors").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return null;
    return {
      kind: "purchases:vendor",
      id: row.id,
      title: row.name,
      subtitle: row.website ?? undefined,
      detailUrl: `/purchases/vendors/${row.id}`,
      fields: { ...row } as Record<string, unknown>,
    };
  });

  platform().entities.registerListResolver("purchases:vendor", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    let q = db.selectFrom("purchases_vendors").selectAll();
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", needle));
    }
    const order = parseSort(query.sort, VENDOR_SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (order.length === 0) q = q.orderBy("name");
    const rows = await q
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .execute();
    return {
      items: rows.map((row) => ({
        kind: "purchases:vendor",
        id: row.id,
        title: row.name,
        subtitle: row.website ?? undefined,
        detailUrl: `/purchases/vendors/${row.id}`,
        fields: { ...row } as Record<string, unknown>,
      })),
    };
  });
}
