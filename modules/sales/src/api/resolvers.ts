// Entity-kind resolvers for sales — let other modules + core-views read
// customers / orders / line items via platform().entities without our tables.

import { type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
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
    if (query.q) q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", `%${query.q!.toLowerCase()}%`));
    const rows = await q.orderBy("name").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map((row) => ({ kind: "sales:customer", id: row.id, title: row.name, detailUrl: `/sales/customers/${row.id}`, fields: { ...row } as Record<string, unknown> })) };
  });

  platform().entities.registerResolver("sales:order", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_orders").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? orderToResolved(row) : null;
  });

  platform().entities.registerListResolver("sales:order", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    let q = db.selectFrom("sales_orders").selectAll();
    const status = query.filter?.status;
    if (typeof status === "string") q = q.where("status", "=", status as never);
    const rows = await q.orderBy("order_date", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(orderToResolved) };
  });

  platform().entities.registerResolver("sales:order_item", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<SalesDB>;
    const row = await db.selectFrom("sales_order_items").selectAll().where("id", "=", id).executeTakeFirst();
    return row
      ? { kind: "sales:order_item", id: row.id, title: row.description ?? "(item)", subtitle: `qty ${row.qty}`, fields: { ...row } as Record<string, unknown> }
      : null;
  });
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
