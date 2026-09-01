// Platform entity-kind resolvers for purchases. Lets other modules /
// the platform's EntityActionsBar look up an order or order_item by
// (kind, id) without touching the purchases tables directly.

import { platform, parseSort, type EntityListQuery, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
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
// Line items live across a join, so a sortable name maps to a QUALIFIED column
// — an unqualified `created_at` would be ambiguous SQL against both tables.
const ITEM_SORT_COL: Record<string, string> = {
  description: "i.description",
  qty: "i.qty",
  unit_cost: "i.unit_cost",
  received_at: "i.received_at",
  created_at: "i.created_at",
  updated_at: "i.updated_at",
  ordered_at: "o.ordered_at",
  vendor: "o.vendor",
};
const ITEM_SORTABLE = new Set(Object.keys(ITEM_SORT_COL));

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

  // Line items ARE listable — "every time this part was bought", "everything
  // consumed by that project". Without this, an order_item could only be
  // resolved one-by-one once you already had its id, so no saved view, app
  // block or agent could ever ask the question. Each row carries its order's
  // vendor / number / purchase date so a consumer never has to join back.
  //
  // `unit_cost` is projected out for foreign callers by the kind's
  // exposableFields (costs stay private to purchases) — the module's own
  // /items route serves the full-fat rows the price panel needs.
  platform().entities.registerListResolver("purchases:order_item", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    const purchasedAt = sql<Date | null>`coalesce(i.received_at, o.arrived_at, o.ordered_at, i.created_at::date)`;
    let q = db
      .selectFrom("purchases_order_items as i")
      .innerJoin("purchases_orders as o", "o.id", "i.order_id")
      .selectAll("i")
      .select([
        "o.vendor as order_vendor",
        "o.order_number",
        "o.status as order_status",
        "o.ordered_at",
      ])
      .select(purchasedAt.as("purchased_at"))
      // Scoped to the default instance - same leak as inventory's base kind
      // (see the note there): a purchases table's lines must not double up
      // under the module's own kind.
      .where("i.instance", "=", "purchases");
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["i.description"], json: ["i.metadata"] })!);
    if (query.filter) {
      // Qualified refs: every one of these columns exists on BOTH joined
      // tables or would otherwise be ambiguous in SQL.
      const NATIVE: Record<string, string> = {
        part_id: "i.part_id",
        order_id: "i.order_id",
        instance: "i.instance",
        consumed_by_module: "i.consumed_by_module",
        consumed_by_entity_type: "i.consumed_by_entity_type",
        consumed_by_entity_id: "i.consumed_by_entity_id",
        order_status: "o.status",
        vendor: "o.vendor",
      };
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        const col = NATIVE[key];
        if (col) {
          if (Array.isArray(val)) {
            const vals = val.filter((v): v is string => typeof v === "string");
            if (vals.length > 0) q = q.where(col as never, "in", vals as never);
          } else if (typeof val === "string") {
            q = q.where(col as never, "=", val as never);
          }
          continue;
        }
        q = q.where(sql<boolean>`i.metadata ->> ${key} = ${String(val)}`);
      }
    }
    const order = parseSort(query.sort, ITEM_SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(ITEM_SORT_COL[col]! as never, dir);
    // Oldest-first by default: a line-item list is read as a history, and a
    // trend renderer wants its points in time order.
    if (order.length === 0) q = q.orderBy(purchasedAt, "asc").orderBy("i.created_at", "asc");
    const rows = await q
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .execute();
    return {
      items: rows.map((row) => ({
        kind: "purchases:order_item",
        id: row.id,
        title: row.description ?? "(item)",
        subtitle: row.order_vendor ? `qty ${row.qty} · ${row.order_vendor}` : `qty ${row.qty}`,
        detailUrl: `/purchases/${row.order_id}`,
        fields: { ...row } as Record<string, unknown>,
      })),
    };
  });

  // Shared by the base kind (scoped to the default instance) and any purchases
  // instance kind (`<name>:item`), which until now had NO resolvers at all: a
  // purchases table created through "+ New category" listed nothing in views,
  // search or the AI - the only instanceable module missing the pair.
  const ordersListResolver = async (orgId: string, query: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("purchases_orders").selectAll();
    if (instance) q = q.where("instance", "=", instance as never);
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["vendor", "order_number", "description", "notes", "tracking_number"], json: ["metadata"] })!);
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
        kind: instance && instance !== "purchases" ? `${instance}:item` : "purchases:order",
        id: row.id,
        title: row.vendor || row.order_number || "(order)",
        subtitle: row.status,
        fields: { ...row } as Record<string, unknown>,
      })),
    };
  };
  platform().entities.registerListResolver("purchases:order", (orgId, query) =>
    ordersListResolver(orgId, query, "purchases"),
  );
  platform().entities.registerInstanceListResolver("purchases", (orgId, instance, query) =>
    ordersListResolver(orgId, query, instance),
  );
  // The single-entity twin - lint:instance-resolvers enforces the pair, and a
  // list whose rows 404 on click is worse than no list.
  platform().entities.registerInstanceResolver("purchases", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
    const row = await db
      .selectFrom("purchases_orders")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instance as never)
      .executeTakeFirst();
    if (!row) return null;
    return {
      kind: `${instance}:item`,
      id: row.id,
      title: row.vendor || row.order_number || "(order)",
      subtitle: row.status,
      fields: { ...row } as Record<string, unknown>,
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
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "website", "contact", "account_number", "notes"], json: ["metadata"] })!);
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
