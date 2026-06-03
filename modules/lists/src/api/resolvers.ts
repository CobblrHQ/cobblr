// Entity-kind resolvers — let other modules + core-views read lists
// entities via platform().entities.lookup()/list() without knowing our tables.

import { type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { ListsDB } from "../db.js";

let registered = false;

export function registerListResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("lists:list", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ListsDB>;
    const row = await db.selectFrom("lists_lists").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? listToResolved(row) : null;
  });

  platform().entities.registerListResolver("lists:list", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ListsDB>;
    const rows = await db
      .selectFrom("lists_lists")
      .selectAll()
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .orderBy("created_at", "desc")
      .execute();
    return { items: rows.map(listToResolved) };
  });

  platform().entities.registerResolver("lists:item", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ListsDB>;
    const row = await db.selectFrom("lists_items").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? itemToResolved(row) : null;
  });

  platform().entities.registerListResolver("lists:item", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ListsDB>;
    let q = db.selectFrom("lists_items").selectAll();
    const listId = query.filter?.list_id;
    if (typeof listId === "string") q = q.where("list_id", "=", listId);
    const rows = await q.limit(Math.min(query.limit ?? 100, 500)).offset(query.offset ?? 0).orderBy("created_at", "asc").execute();
    return { items: rows.map(itemToResolved) };
  });
}

function listToResolved(row: { id: string; title: string; description: string | null }): ResolvedEntity {
  return {
    kind: "lists:list",
    id: row.id,
    title: row.title,
    subtitle: row.description ?? undefined,
    detailUrl: `/lists/${row.id}`,
    fields: { title: row.title, description: row.description },
  };
}

function itemToResolved(row: {
  id: string; list_id: string; title: string; note: string | null; qty: string | null; checked: boolean;
}): ResolvedEntity {
  return {
    kind: "lists:item",
    id: row.id,
    title: row.title,
    subtitle: row.qty ?? row.note ?? undefined,
    fields: { title: row.title, note: row.note, qty: row.qty, checked: row.checked, list_id: row.list_id },
  };
}
