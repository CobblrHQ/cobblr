import { groupListRows } from "@cobblr/platform-contract/grouped-list";
// Entity-kind resolver — lets other modules + core-views read builds via
// platform().entities.lookup()/list() without knowing our tables.

import { registerRowHistoryWriter, columnSet, countOf } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import { platform, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import type { BuildsDB } from "../db.js";

let registered = false;

export function registerBuildsResolvers(): void {
  if (registered) return;
  registered = true;
  registerRowHistoryWriter("builds:build", "builds_builds");
  platform().entities.registerResolver("builds:work-order", async (orgId, id) => {
    const db = await platform().tenants.getDb(orgId) as Kysely<BuildsDB>;
    const row = await db.selectFrom("builds_planned").selectAll().where("id", "=", id).executeTakeFirst();
    return row?.assembly ? { kind: "builds:work-order", id: row.id, title: countOf(Number(row.qty), "board"), detailUrl: `/builds/${row.build_id}?order=${row.id}`, fields: { name: countOf(Number(row.qty), "board"), state: row.assembly.state, assembly_finish_proof: row.assembly.finish_intent ?? null } } : null;
  });
  platform().entities.registerResolver("builds:inspection", async (orgId, id) => {
    const db = await platform().tenants.getDb(orgId) as Kysely<BuildsDB>;
    const row = await db.selectFrom("builds_inspections").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? { kind: "builds:inspection", id: row.id, title: row.serial_code || `Board ${row.ordinal}`, detailUrl: `/builds/inspections/${row.id}`, fields: { name: row.serial_code || `Board ${row.ordinal}`, status: row.status, serial_code: row.serial_code, ordinal: row.ordinal, order_id: row.order_id, front_file_id: row.front_file_id, back_file_id: row.back_file_id, metadata: row.metadata } } : null;
  });
  platform().entities.registerListResolver("builds:inspection", async (orgId, query) => {
    const db = await platform().tenants.getDb(orgId) as Kysely<BuildsDB>;
    let q = db.selectFrom("builds_inspections").selectAll();
    const native = columnSet<BuildsDB["builds_inspections"]>()(["id", "serial_code", "status", "ordinal", "order_id"]);
    for (const [key, value] of Object.entries(query.filter ?? {})) {
      if (value === undefined) continue;
      if (native.has(key)) q = q.where(key as never, value === null ? "is" : "=", value as never);
      else q = q.where(sql<boolean>`metadata ->> ${key} = ${String(value)}`);
    }
    if (query.q?.trim()) q = q.where(eb => textSearchWhere(eb, query.q, { text: ["serial_code", "notes", "status"] })!);
    const rows = await q.orderBy("inspected_at", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(row => ({ kind: "builds:inspection", id: row.id, title: row.serial_code || `Board ${row.ordinal}`, detailUrl: `/builds/inspections/${row.id}`, fields: { name: row.serial_code || `Board ${row.ordinal}`, status: row.status, serial_code: row.serial_code, ordinal: row.ordinal, order_id: row.order_id, metadata: row.metadata } })) };
  });
  platform().entities.registerListResolver("builds:work-order", async (orgId, query) => {
    const db = await platform().tenants.getDb(orgId) as Kysely<BuildsDB>;
    let q = db.selectFrom("builds_planned").selectAll().where("assembly", "is not", null);
    if (query.q?.trim()) q = q.where(eb => textSearchWhere(eb, query.q, { text: ["notes", "status"] })!);
    const rows = await q.orderBy("created_at", "desc").limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(row => ({ kind: "builds:work-order", id: row.id, title: countOf(Number(row.qty), "board"), detailUrl: `/builds/${row.build_id}?order=${row.id}`, fields: { name: countOf(Number(row.qty), "board"), state: row.assembly!.state } })) };
  });



  platform().entities.registerResolver("builds:build", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
    const row = await db.selectFrom("builds_builds").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? buildToResolved(row) : null;
  });

  platform().entities.registerListResolver("builds:build", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<BuildsDB>;
    let q = db.selectFrom("builds_builds").selectAll();
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "description", "notes"] })!);
    const rows = (await groupListRows(db, q .orderBy("name", "asc"), query)) ?? await q
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
  metadata?: unknown;
}): ResolvedEntity {
  return {
    kind: "builds:build",
    id: row.id,
    title: row.name,
    subtitle: row.description ?? undefined,
    detailUrl: `/builds/${row.id}`,
    fields: { name: row.name, description: row.description, notes: row.notes, metadata: row.metadata ?? {} },
  };
}
