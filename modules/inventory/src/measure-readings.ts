// A part's measured values, read off its title, description, notes and custom
// fields (measureReadings in @cobblr/platform-contract/measure), kept in
// inventory_parts.measures so search, sort and filter find "4k7" by value
// without the record being changed (migration 0013).
//
// Readings are derived data, and fifty-odd write paths
// change a part's text. None of them has to remember readings: Postgres keeps
// measures_key (a hash of the text the readings come from) on every write,
// and a row whose measures_for differs is read again here before any search,
// sort or filter that reads values (refreshMeasureReadings), and by the heal
// pass (heal-measure-readings.ts) for every row from before readings existed.
// The partial index on the stale rows makes the happy path one index probe.

import { sql, type Kysely } from "kysely";
import { measureReadings, measureTokens } from "@cobblr/platform-contract/measure";
import type { InventoryDB } from "./db.js";

/** How many stale rows one request reads again before answering. The heal
 *  pass does the backlog; a request only ever meets what changed since. */
const REQUEST_BATCH = 2000;

/** Read again the parts whose readings are missing or stale (all of an
 *  instance, or every instance), at most `limit`; answers how many. One
 *  select over the partial index and one update, and a row edited between
 *  the two keeps its stale mark (the update matches on the key it read). */
export async function refreshMeasureReadings(
  db: Kysely<InventoryDB>,
  opts: { instance?: string; limit?: number; neverRead?: boolean; madeBefore?: Date } = {},
): Promise<number> {
  let q = db
    .selectFrom("inventory_parts")
    .select(["id", "name", "description", "notes", "metadata", sql<string>`measures_key`.as("key")])
    .where(sql<boolean>`measures_for is distinct from measures_key`);
  if (opts.instance) q = q.where("instance", "=", opts.instance);
  if (opts.neverRead) q = q.where(sql<boolean>`measures is null`);
  if (opts.madeBefore) q = q.where("created_at", "<", opts.madeBefore);
  const rows = await q.limit(opts.limit ?? REQUEST_BATCH).execute();
  if (rows.length === 0) return 0;
  const batch = rows.map((r) => ({
    id: r.id,
    k: r.key,
    m: measureReadings({ texts: { name: r.name, description: r.description, notes: r.notes }, metadata: r.metadata }),
  }));
  await sql`
    update inventory_parts p
       set measures = x.m, measures_for = x.k
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as x(id uuid, k text, m jsonb)
     where p.id = x.id and p.measures_key = x.k
  `.execute(db);
  return rows.length;
}

/** A part's value in one of its own fields, as a number for sort and compare:
 *  a JSON number, a measure field's value, a number typed as text, or the
 *  reading of a text value ("100nF" is 1e-7). Null when the field holds none. */
export function measuredValueSql(table: string, field: string) {
  const meta = sql.ref(`${table}.metadata`);
  const measures = sql.ref(`${table}.measures`);
  return sql<number | null>`coalesce(
    case when jsonb_typeof(${meta} -> ${field}) = 'number' then (${meta} ->> ${field})::numeric end,
    case when jsonb_typeof(${meta} -> ${field} -> 'value') = 'number' then (${meta} -> ${field} ->> 'value')::numeric end,
    case when jsonb_typeof(${meta} -> ${field}) = 'string' and (${meta} ->> ${field}) ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${meta} ->> ${field})::numeric end,
    (select (r ->> 'value')::numeric from jsonb_array_elements(coalesce(${measures}, '[]'::jsonb)) r
      where r ->> 'field' = ${field} and jsonb_typeof(r -> 'value') = 'number' limit 1)
  )`;
}

/** Does this list query read values: a search naming one, a sort, or a
 *  comparison. Only then is anything read again before answering. */
export function readsValues(q: { search?: string; q?: string; sort?: readonly string[]; where?: readonly unknown[]; doesnt_fit?: string }): boolean {
  const text = (q.search ?? q.q ?? "").trim();
  return !!(q.sort?.length || q.where?.length || q.doesnt_fit === "1" || q.doesnt_fit === "true" || (text && measureTokens(text)));
}
