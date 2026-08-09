import { platform, parseSort, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { RecordsDB } from "../db.js";

let registered = false;

// Native columns the list resolver will order by; anything else is dropped by
// parseSort rather than reaching SQL.
const SORTABLE = new Set(["name", "location_id", "created_at", "updated_at"]);

export function registerRecordsResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("records:record", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<RecordsDB>;
    const row = await db
      .selectFrom("records_records")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedRecord(row);
  });

  const recordsListResolver = async (orgId: string, query: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<RecordsDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("records_records").selectAll();
    if (instance) q = q.where("instance", "=", instance as never);
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", needle));
    }
    if (query.filter) {
      const NATIVE = new Set(["location_id"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'records'
              and a.source_type = 'record'
              and a.source_id = records_records.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          // Array → IN (multi-value filter); scalar → equality.
          if (Array.isArray(val)) {
            const vals = val.filter((v): v is string => typeof v === "string");
            if (vals.length > 0) q = q.where(key as never, "in", vals as never);
          } else if (typeof val === "string") {
            q = q.where(key as never, "=", val as never);
          }
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // Comparison predicates. Whitelist of comparable columns so unknown /
    // bogus cols fall through silently.
    if (query.where) {
      const COMPARABLE = new Set(["created_at", "updated_at"]);
      for (const p of query.where) {
        if (!COMPARABLE.has(p.col)) continue;
        if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) continue;
        if (p.ref_col) {
          if (!COMPARABLE.has(p.ref_col)) continue;
          q = q.where(
            sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${sql.ref(p.ref_col)}`,
          );
        } else if (p.value !== undefined) {
          const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
          q = q.where(sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${v}`);
        }
      }
    }
    const order = parseSort(query.sort, SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (!order.some((o) => o.col === "name")) q = q.orderBy("name", "asc");
    const rows = await q.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedRecord(r)) };
  };
  platform().entities.registerListResolver("records:record", (orgId, query) =>
    recordsListResolver(orgId, query),
  );
  platform().entities.registerInstanceListResolver("records", (orgId, instance, query) =>
    recordsListResolver(orgId, query, instance),
  );
  // Single-entity lookup for an INSTANCE kind ("bookshelf:item"). Registering
  // the list resolver WITHOUT this one is a trap: the collection renders fine
  // (that's the list), while every generic single-record read —
  // entities.lookup — returns null. That is exactly what silently broke the
  // cover auto-fetch for a book on a shelf: the search phrase is derived from
  // a lookup, so it derived nothing and then reported "these need a name
  // first" about records that plainly had names (reported 2026-07-18).
  // lint:instance-resolvers now enforces the pair.
  platform().entities.registerInstanceResolver("records", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<RecordsDB>;
    const row = await db
      .selectFrom("records_records")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instance as never)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedRecord(row);
  });
}

function toResolvedRecord(row: {
  id: string;
  name: string;
  [k: string]: unknown;
}): ResolvedEntity {
  return {
    kind: "records:record",
    id: row.id,
    title: row.name,
    // Carry the photo so generic surfaces (the labels browser tiles) show it
    // instead of an initial-letter chip. Mirrors assets' toResolvedAsset.
    image_path: (row.image_path as string | null | undefined) ?? undefined,
    fields: row as unknown as Record<string, unknown>,
  };
}
