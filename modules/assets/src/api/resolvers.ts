import { platform, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";

let registered = false;

export function registerAssetsResolvers(): void {
  if (registered) return;
  registered = true;

  // D3: per-entity recurrence scanner. Reads metadata.water_rrule
  // (or other rrule fields if we add more) off each asset and hands
  // them to core-recurrence. Modules read their own internal data
  // here — no exposableFields projection.
  platform().recurrence.registerScanner("assets:asset", async (orgId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const rows = await db
      .selectFrom("assets_assets")
      .select(["id", "name", "metadata"])
      .execute();
    const out: Array<{ entityId: string; rrule: string; title: string; event: string }> = [];
    for (const r of rows) {
      const md = (r.metadata as Record<string, unknown> | null) ?? {};
      const rrule = md.water_rrule;
      if (typeof rrule === "string" && rrule.length > 0) {
        out.push({
          entityId: r.id,
          rrule,
          title: r.name,
          event: "assets.asset.recurred",
        });
      }
    }
    return out;
  });

  platform().entities.registerResolver("assets:asset", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedAsset(row);
  });

  const assetsListResolver = async (orgId: string, query: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("assets_assets").selectAll();
    if (instance) q = q.where("instance", "=", instance as never);
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", needle));
    }
    if (query.filter) {
      const NATIVE = new Set(["state", "location_id", "type", "manufacturer"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'assets'
              and a.source_type = 'asset'
              and a.source_id = assets_assets.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          if (typeof val === "string") q = q.where(key as never, "=", val as never);
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates. Whitelist of comparable columns so
    // unknown / bogus cols fall through silently.
    if (query.where) {
      const COMPARABLE = new Set([
        "purchased_at",
        "warranty_until",
        "last_service_at",
        "excitement",
        "quantity",
        "created_at",
        "updated_at",
      ]);
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
    const rows = await q.orderBy("name", "asc").limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedAsset(r)) };
  };
  platform().entities.registerListResolver("assets:asset", (orgId, query) =>
    assetsListResolver(orgId, query),
  );
  platform().entities.registerInstanceListResolver("assets", (orgId, instance, query) =>
    assetsListResolver(orgId, query, instance),
  );
}

function toResolvedAsset(row: {
  id: string;
  name: string;
  state: string;
  [k: string]: unknown;
}): ResolvedEntity {
  return {
    kind: "assets:asset",
    id: row.id,
    title: row.name,
    subtitle: row.state,
    fields: row as unknown as Record<string, unknown>,
  };
}
