// Entity-kind resolver + list resolver for core-tags:tag.

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import type { CoreTagsDB } from "../db.js";

let registered = false;

export function registerTagResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("core-tags:tag", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreTagsDB>;
    const row = await db
      .selectFrom("core_tags_tags")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedTag(row);
  });

  platform().entities.registerListResolver("core-tags:tag", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreTagsDB>;
    const limit = Math.min(query.limit ?? 100, 500);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("core_tags_tags").selectAll();
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "color"] })!);
    const sortable = new Set(["name", "created_at", "updated_at"]);
    const specs = (query.sort ?? ["name"]).filter((s) => sortable.has(s.replace(/^-/, "")));
    let sortedQ = q;
    for (const spec of specs) {
      const desc = spec.startsWith("-");
      const col = spec.replace(/^-/, "");
      sortedQ = sortedQ.orderBy(col as never, desc ? "desc" : "asc");
    }
    const rows = await sortedQ.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedTag(r)) };
  });
}

function toResolvedTag(row: {
  id: string;
  name: string;
  color: string | null;
}): ResolvedEntity {
  return {
    kind: "core-tags:tag",
    id: row.id,
    title: row.name,
    subtitle: row.color ?? undefined,
    detailUrl: `/tags/${row.id}`,
    fields: {
      name: row.name,
      color: row.color,
    },
  };
}
