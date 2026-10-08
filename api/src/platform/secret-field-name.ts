import { CompiledQuery } from "kysely";
import { historyTableFor } from "./history-store.js";
import { getKind, baseKindOf } from "./entities.js";
import { getTenantDb } from "../db/tenant.js";

export async function secretNameIsUnused(orgId: string, kinds: readonly string[], name: string): Promise<boolean> {
  const db = await getTenantDb(orgId);
  const checked = new Set<string>();
  for (const kind of kinds) {
    if (((await getKind(kind)) ?? (await getKind(await baseKindOf(orgId, kind))))?.fields.some((field) => field.name === name)) return false;
    const table = await historyTableFor(orgId, kind);
    if (!table || checked.has(table)) continue;
    checked.add(table);
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const found = await db.executeQuery(CompiledQuery.raw(`select true as present from ${quoted} where metadata ? $1 and metadata -> $1 is distinct from 'null'::jsonb and (metadata -> $1 ->> '__cobblr_secret') is distinct from '1' limit 1`, [name]));
    if (found.rows.length) return false;
  }
  return true;
}
