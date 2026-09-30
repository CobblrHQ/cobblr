// Entity-kind resolvers for sales — let other modules + core-views read
// customers / orders / line items via platform().entities without our tables.

import { type Kysely } from "kysely";
import { platform, type EntityListQuery, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import type { SalesDB } from "../db.js";

let registered = false;

export function registerSalesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("sales:customer", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_customers").selectAll().where("id", "=", id).executeTakeFirst();
    return row
      ? { kind: "sales:customer", id: row.id, title: row.name, detailUrl: `/sales/customers/${row.id}`, fields: { ...row } as Record<string, unknown> }
      : null;
  });

  platform().entities.registerListResolver("sales:customer", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    let q = db.selectFrom("sales_customers").selectAll();
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "email", "phone", "address", "notes"], json: ["metadata"] })!);
    const rows = await q.orderBy("name").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map((row) => ({ kind: "sales:customer", id: row.id, title: row.name, detailUrl: `/sales/customers/${row.id}`, fields: { ...row } as Record<string, unknown> })) };
  });

  platform().entities.registerResolver("sales:order", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_orders").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? orderToResolved(row) : null;
  });

  // The module's own kind is its default collection, as inventory:part is;
  // a named collection's orders are `<name>:item`, below. Listing every
  // collection here answered each order twice in search, once per kind.
  platform().entities.registerListResolver("sales:order", (orgId, query) => listOrders(orgId, query, "sales"));
  platform().entities.registerInstanceListResolver("sales", (orgId, instance, query) => listOrders(orgId, query, instance));
  // The single-record twin: a named collection's order is read by id as
  // `<name>:item`, and only from that collection.
  platform().entities.registerInstanceResolver("sales", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_orders").selectAll().where("id", "=", id).where("instance", "=", instance).executeTakeFirst();
    return row ? orderToResolved(row) : null;
  });

  platform().entities.registerResolver("sales:order_item", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_order_items").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? itemToResolved(row) : null;
  });

  platform().entities.registerListResolver("sales:order_item", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    let q = db.selectFrom("sales_order_items").selectAll();
    const orderId = query.filter?.order_id;
    if (typeof orderId === "string") q = q.where("order_id", "=", orderId);
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["description"], json: ["metadata"] })!);
    const rows = await q.orderBy("created_at", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(itemToResolved) };
  });
}

async function listOrders(orgId: string, query: EntityListQuery, instance: string) {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
  let q = db.selectFrom("sales_orders").selectAll().where("instance", "=", instance);
  const status = query.filter?.status;
  if (typeof status === "string") q = q.where("status", "=", status as never);
  if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["customer_name", "order_number", "notes", "shipping_address"], json: ["metadata"] })!);
  const rows = await q.orderBy("order_date", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
  return { items: rows.map(orderToResolved) };
}

function itemToResolved(row: { id: string; description: string | null; qty: string | number }): ResolvedEntity {
  return { kind: "sales:order_item", id: row.id, title: row.description ?? "(item)", subtitle: `qty ${row.qty}`, fields: { ...row } as Record<string, unknown> };
}

function orderToResolved(row: {
  id: string; customer_name: string | null; order_number: string | null; status: string;
}): ResolvedEntity {
  return {
    kind: "sales:order",
    id: row.id,
    title: row.customer_name || row.order_number || "(sales order)",
    subtitle: row.status,
    detailUrl: `/sales/${row.id}`,
    fields: { ...row } as Record<string, unknown>,
  };
}
