// Entity-kind resolvers — let other modules + core-views read knowledge entries
// via platform().entities.lookup()/list() without knowing our table.

import { type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { KnowledgeDB } from "../db.js";

let registered = false;

export function registerKnowledgeResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("knowledge:entry", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<KnowledgeDB>;
    const row = await db
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? entryToResolved(row) : null;
  });

  platform().entities.registerListResolver("knowledge:entry", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<KnowledgeDB>;
    let q = db.selectFrom("knowledge_entries").selectAll();
    const kind = query.filter?.kind;
    if (typeof kind === "string") q = q.where("kind", "=", kind);
    const pinned = query.filter?.pinned;
    if (pinned === true || pinned === "true") q = q.where("pinned", "=", true);
    const rows = await q
      .limit(Math.min(query.limit ?? 50, 500))
      .offset(query.offset ?? 0)
      .orderBy("updated_at", "desc")
      .execute();
    return { items: rows.map(entryToResolved) };
  });
}

function entryToResolved(row: {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  pinned: boolean;
  code: string | null;
  image_path: string | null;
}): ResolvedEntity {
  return {
    kind: "knowledge:entry",
    id: row.id,
    title: row.title,
    subtitle: row.kind ?? undefined,
    image_path: row.image_path ?? undefined,
    detailUrl: `/knowledge/${row.id}`,
    fields: {
      title: row.title,
      body: row.body,
      kind: row.kind,
      pinned: row.pinned,
      code: row.code,
      image_path: row.image_path,
    },
  };
}
