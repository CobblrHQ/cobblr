import { sql, type Kysely } from "kysely";
import type { InventoryDB } from "../db.js";

export async function materialTotals(db: Kysely<InventoryDB>, ids: string[]) {
  if (!ids.length) return new Map();
  const rows = await db.selectFrom("inventory_consumption").select([
    "part_id",
    sql<string>`coalesce(sum(delta) filter (where kind is distinct from 'correction' and (delta < 0 or exists (
      select 1 from inventory_consumption consumed where consumed.part_id = inventory_consumption.part_id
      and consumed.source_kind = inventory_consumption.source_kind and consumed.source_id = inventory_consumption.source_id
      and consumed.delta < 0 and consumed.kind is distinct from 'correction'))), 0)`.as("net"),
    sql<Date | null>`min(at) filter (where delta < 0 and kind is distinct from 'correction')`.as("first_used"),
    sql<Date | null>`max(at) filter (where delta < 0 and kind is distinct from 'correction')`.as("last_used"),
    sql<string>`count(distinct source_id) filter (where delta < 0 and source_id is not null)`.as("jobs"),
  ]).where("part_id", "in", ids).groupBy("part_id").execute();
  return new Map(rows.map((r) => [r.part_id, r]));
}
