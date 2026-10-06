import { platform, columnSet, parseSort, textSearchWhere, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { groupListRows } from "@cobblr/platform-contract/grouped-list";
import { sql, type Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import type { TermRow } from "./terms-store.js";

const columns = columnSet<CoreMaintenanceDB["core_maintenance_entries"]>()(["name", "entity_id", "schedule_id", "term_start", "term_end", "cost_cents", "currency", "reference", "quantity", "performed_by", "performed_at"]);
function resolved(r: TermRow): ResolvedEntity {
  return { kind: "core-maintenance:term", id: r.id, title: r.name, detailUrl: `/open/${r.entity_module}:${r.entity_type}/${r.entity_id}`,
    fields: { ...r, quantity: r.quantity == null ? null : Number(r.quantity), publisher: r.metadata.publisher ?? null } };
}
export function registerTermResolvers(): void {
  const dbOf = async (orgId: string) => await platform().tenants.getDb(orgId) as Kysely<CoreMaintenanceDB>;
  platform().entities.registerResolver("core-maintenance:term", async (orgId, id) => {
    const row = await (await dbOf(orgId)).selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).where("is_term", "=", true).executeTakeFirst();
    return row ? resolved(row) : null;
  });
  platform().entities.registerListResolver("core-maintenance:term", async (orgId, query: EntityListQuery) => {
    const db = await dbOf(orgId);
    let q = db.selectFrom("core_maintenance_entries").selectAll().where("is_term", "=", true);
    if (query.q) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "reference"], json: ["metadata"] })!);
    for (const [key, value] of Object.entries(query.filter ?? {})) {
      if (value == null) continue;
      if (columns.has(key)) q = Array.isArray(value) ? q.where(key as never, "in", value as never) : q.where(key as never, "=", value as never);
      else q = q.where(sql<boolean>`metadata ->> ${key} = ${String(value)}`);
    }
    for (const p of query.where ?? []) {
      if (columns.has(p.col) && ["=", "!=", ">", ">=", "<", "<="].includes(p.op)) q = q.where(p.col as never, p.op as never, p.value as never);
    }
    const order = parseSort(query.sort, columns);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (!order.length) q = q.orderBy(sql`term_end desc nulls last`);
    q = q.orderBy("id");
    const rows = await groupListRows(db, q, query) ?? await q.limit(Math.min(query.limit ?? 50, 200)).offset(query.offset ?? 0).execute();
    return { items: rows.map(resolved) };
  });
}
