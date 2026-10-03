// Entity-kind resolver — lets other modules + core-views read builds via
// platform().entities.lookup()/list() without knowing our tables.

import { registerRowHistoryWriter } from "@cobblr/platform-contract";
import { type Kysely } from "kysely";
import { platform, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import type { BuildsDB } from "../db.js";

let registered = false;

export function registerBuildsResolvers(): void {
  if (registered) return;
  registered = true;
  registerRowHistoryWriter("builds:build", "builds_builds");

  platform().entities.registerResolver("builds:build", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
    const row = await db.selectFrom("builds_builds").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? buildToResolved(row) : null;
  });

  platform().entities.registerListResolver("builds:build", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
    let q = db.selectFrom("builds_builds").selectAll();
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "description", "notes"] })!);
    const rows = await q
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .orderBy("name", "asc")
      .execute();
    return { items: rows.map(buildToResolved) };
  });
}

function buildToResolved(row: {
  id: string;
  name: string;
  description: string | null;
  notes: string | null;
}): ResolvedEntity {
  return {
    kind: "builds:build",
    id: row.id,
    title: row.name,
    subtitle: row.description ?? undefined,
    detailUrl: `/builds/${row.id}`,
    fields: { name: row.name, description: row.description, notes: row.notes },
  };
}
