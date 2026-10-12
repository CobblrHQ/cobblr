import { moneyCurrencyPaths } from "@cobblr/platform-contract/money";
import { sql, type Kysely, type RawBuilder, type SelectQueryBuilder } from "kysely";

export class GroupingError extends Error {
  readonly status = 400;
  toJSON() { return { error: { code: "invalid_grouping", message: this.message } }; }
}

export function readGroupKeys(raw: unknown): Array<string | null> | undefined {
  if (raw === undefined) return undefined;
  let keys: unknown;
  try { keys = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new GroupingError("Group keys must be a list of values."); }
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2 || keys.some((k) => k !== null && typeof k !== "string")) throw new GroupingError("Group keys must contain one or two text values.");
  return keys;
}

export interface GroupBy { field: string; bucket?: "month" | "quarter" | "year" }
export interface GroupTotal { currency: string | null; value: number }
export interface EntityGroup {
  keys: Array<string | null>;
  count: number;
  totals: Record<string, GroupTotal[]>;
  item_ids: string[];
}
export interface GroupedResult {
  groups: EntityGroup[];
  totals: Record<string, GroupTotal[]>;
  /** The fields whose total is value x this quantity field rather than a sum
   *  of the value (a per-unit field: length per ball, price each). */
  weighted_by?: Record<string, string>;
  total: number;
  group_total: number;
}
export interface GroupPlan {
  by: GroupBy[];
  /** The fields to total. `times` names the quantity field a per-unit field
   *  is multiplied by; a per-unit field without one is never totalled. */
  fields: Array<{ name: string; money?: "amount" | "cents"; times?: string }>;
  currency: string;
  values?: Record<string, RawBuilder<unknown>>;
  numbers?: Record<string, RawBuilder<number>>;
  /** Added to a per-unit field's value x quantity, per record: what is left
   *  of the units already opened, which the count no longer holds (a yarn's
   *  opened skein, #5897). */
  plus?: Record<string, RawBuilder<number>>;
  where?: RawBuilder<boolean>;
  search?: string;
  search_fields?: string[];
  /** Carried onto the result: which totals are value x quantity. */
  weighted_by?: Record<string, string>;
  result?: GroupedResult;
}
export interface GroupPage { group_offset?: number; group_limit?: number; group_keys?: Array<string | null>; offset?: number; limit?: number }

export function normalizeGrouping(raw: unknown): GroupBy[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try { raw = JSON.parse(raw); } catch { throw new GroupingError("Grouping must name one or two columns."); }
  }
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > 2) throw new GroupingError("Group by at most two columns.");
  const seen = new Set<string>();
  return list.map((entry) => {
    const value = typeof entry === "string" ? { field: entry } : entry as GroupBy;
    if (!value || typeof value.field !== "string" || !value.field.trim() || seen.has(value.field)) throw new GroupingError("Choose a different field for each group.");
    if (value.bucket && !["month", "quarter", "year"].includes(value.bucket)) throw new GroupingError("Choose month, quarter or year for a date group.");
    seen.add(value.field);
    return { field: value.field.trim(), ...(value.bucket ? { bucket: value.bucket } : {}) };
  });
}

const jsonValue = (name: string) => sql`coalesce(data->${name}, data->'metadata'->${name})`;
const textValue = (name: string) => sql`(${jsonValue(name)} #>> '{}')`;
const numeric = (value: ReturnType<typeof sql>) => sql`case when (${value}) ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then (${value})::numeric end`;

export function groupedListSql<O>(source: SelectQueryBuilder<any, any, O>, plan: GroupPlan, page: GroupPage) {
  const keys = plan.by.map(({ field, bucket }) => {
    const value = plan.values?.[field] ?? textValue(field === "title" ? "name" : field);
    if (!bucket) return value;
    // Month and year never cast a tenant value. Quarter arithmetic touches
    // only a validated month, so malformed dates cannot empty every group.
    const month = sql`case when ${value} ~ '^[0-9]{4}-(0[1-9]|1[0-2])($|-[0-9]{2})' then substring(${value}, 1, 7) end`;
    if (bucket === "month") return month;
    if (bucket === "year") return sql`substring(${month}, 1, 4)`;
    return sql`case when ${month} is not null then substring(${month}, 1, 4) || '-Q' || (((substring(${month}, 6, 2)::int - 1) / 3) + 1)::text end`;
  });
  const values = plan.fields.map((f) => {
    const raw = jsonValue(f.name);
    const amount = f.money ? sql`coalesce(${raw}->>'amount', ${raw} #>> '{}')` : sql`(${raw} #>> '{}')`;
    // MONEY-OK: normalize native minor units into main units in the database aggregation, before the shared formatter reads the result.
    const one = plan.numbers?.[f.name] ?? (f.money === "cents" ? sql`case when jsonb_typeof(${raw}) = 'object' then ${numeric(amount)} else ${numeric(amount)} / 100 end` : numeric(amount));
    const times = f.times ? sql`(${one}) * (${plan.numbers?.[f.times] ?? numeric(textValue(f.times))})` : null;
    const number = times ? (plan.plus?.[f.name] ? sql`coalesce(${times}, 0) + coalesce(${plan.plus[f.name]}, 0)` : times) : one;
    const metadataCurrency = sql`coalesce(${sql.join(moneyCurrencyPaths(f.name).map((path) => sql`nullif(data->'metadata' #>> ${path}::text[], '')`))})`;
    const chosenCurrency = sql`coalesce(nullif(${raw}->>'currency', ''), ${metadataCurrency})`;
    const currency = f.money ? sql`case when ${chosenCurrency} ~ '^[A-Za-z]{3}$' then upper(${chosenCurrency}) else ${plan.currency} end` : sql`null::text`;
    return sql`(${f.name}::text, ${currency}, ${number})`;
  });
  const totals = values.length ? sql`
    currency_sums as (
      select path, field, currency, sum(value) as value
      from levels cross join lateral (values ${sql.join(values)}) as amounts(field, currency, value)
      where value is not null group by path, field, currency
    ), field_sums as (
      select path, field, jsonb_agg(jsonb_build_object('currency', currency, 'value', value) order by currency) as sums
      from currency_sums group by path, field
    ), all_totals as (
      select path, jsonb_object_agg(field, sums) as totals from field_sums group by path
    ),` : sql`all_totals as (select array[]::text[] as path, '{}'::jsonb as totals),`;
  const readableSearch = plan.search?.trim() ? sql`jsonb_build_array(${sql.join((plan.search_fields ?? ["name"]).map((f) => jsonValue(f)))})::text ilike ${"%" + plan.search.trim().replace(/[\\%_]/g, (v) => "\\" + v) + "%"}` : undefined;
  const predicates = [plan.where, readableSearch].filter((p) => !!p);
  const narrowed = predicates.length ? sql`where ${sql.join(predicates, sql` and `)}` : sql``;
  const pathFilter = page.group_keys ? sql`where keys is not distinct from ${page.group_keys}::text[]` : sql``;
  return sql<GroupedResult>`
    with source as (${source.clearLimit().clearOffset()}),
    data_rows as (select to_jsonb(source) as data, row_number() over () as position from source),
    keyed as (select *, array[${sql.join(keys)}]::text[] as keys from data_rows ${narrowed}),
    levels as (select *, keys[1:depth] as path from keyed cross join generate_series(0, ${plan.by.length}) as depth),
    counts as (select path, count(*)::int as count from levels group by path),
    ${totals}
    chosen as (
      select keys from keyed ${pathFilter} group by keys order by keys
      limit ${Math.min(Math.max(page.group_limit ?? 20, 1), 20)} offset ${Math.max(page.group_offset ?? 0, 0)}
    ), ranked as (
      select keyed.*, row_number() over (partition by keyed.keys order by position) as rn
      from keyed join chosen on keyed.keys is not distinct from chosen.keys
    ), shown as (
      select * from ranked where rn > ${Math.max(page.offset ?? 0, 0)} and rn <= ${Math.max(page.offset ?? 0, 0) + Math.min(Math.max(page.limit ?? 20, 1), 50)}
    ), headers as (
      select distinct keys[1:depth] as path from chosen cross join generate_series(1, ${plan.by.length}) as depth
    )
    select coalesce((
      select jsonb_agg(jsonb_build_object('keys', h.path, 'count', c.count, 'totals', coalesce(t.totals, '{}'::jsonb),
        'item_ids', coalesce((select jsonb_agg(data->>'id' order by position) from shown where keys = h.path), '[]'::jsonb)) order by h.path)
      from headers h join counts c on c.path is not distinct from h.path left join all_totals t on t.path is not distinct from h.path
    ), '[]'::jsonb) as groups,
    coalesce((select totals from all_totals where cardinality(path) = 0), '{}'::jsonb) as totals,
    coalesce((select count from counts where cardinality(path) = 0), 0) as total,
    (select count(distinct keys)::int from keyed) as group_total
  `;
}

/** Run against the owner's filtered query. The request-local plan returns
 *  aggregates to the kernel; row projection remains the owner's resolver. */
export async function groupListRows<DB, O>(db: Kysely<DB>, source: SelectQueryBuilder<any, any, O>, query: GroupPage & { group_plan?: GroupPlan }): Promise<O[] | null> {
  const plan = query.group_plan;
  if (!plan) return null;
  const result = (await groupedListSql(source, plan, query).execute(db)).rows[0]!;
  plan.result = plan.weighted_by && Object.keys(plan.weighted_by).length ? { ...result, weighted_by: plan.weighted_by } : result;
  const ids = result.groups.flatMap((g) => g.item_ids);
  if (!ids.length) return [];
  return db.selectFrom(source.clearLimit().clearOffset().as("group_source")).selectAll().where(sql<boolean>`id::text = any(${ids}::text[])`).execute() as Promise<O[]>;
}
