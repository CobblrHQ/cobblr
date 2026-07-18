import { platform, parseSort, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";

let registered = false;

// Native columns the list resolver will order by; anything else is dropped by
// parseSort rather than reaching SQL. Union of the NATIVE/COMPARABLE filter
// whitelists below plus name.
const SORTABLE = new Set([
  "name",
  "state",
  "type",
  "manufacturer",
  "location_id",
  "excitement",
  "quantity",
  "purchased_at",
  "warranty_until",
  "last_service_at",
  "created_at",
  "updated_at",
]);

export function registerAssetsResolvers(): void {
  if (registered) return;
  registered = true;

  // D3: per-entity recurrence scanner. Hands each asset's watering schedule to
  // core-recurrence, which fires assets.asset.recurred per-plant on the due
  // date (a wire then waters it — e.g. digifab:run-command at an irrigation
  // controller). Two ways to express the schedule, raw wins:
  //   metadata.water_rrule       — a full iCal rule, for power users
  //   metadata.water_every_days  — the plant-care field; synthesised into a
  //                                FREQ=DAILY;INTERVAL=n rule anchored at
  //                                last_watered (else created_at) so it's
  //                                deterministic, not parse-time-relative.
  // Modules read their own internal data here — no exposableFields projection.
  platform().recurrence.registerScanner("assets:asset", async (orgId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const rows = await db
      .selectFrom("assets_assets")
      .select(["id", "name", "metadata", "created_at"])
      .execute();
    const out: Array<{ entityId: string; rrule: string; title: string; event: string }> = [];
    for (const r of rows) {
      const md = (r.metadata as Record<string, unknown> | null) ?? {};
      const rrule = waterRrule(md, r.created_at as unknown);
      if (rrule) {
        out.push({ entityId: r.id, rrule, title: r.name, event: "assets.asset.recurred" });
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
    const order = parseSort(query.sort, SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (!order.some((o) => o.col === "name")) q = q.orderBy("name", "asc");
    const rows = await q.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedAsset(r)) };
  };
  platform().entities.registerListResolver("assets:asset", (orgId, query) =>
    assetsListResolver(orgId, query),
  );
  platform().entities.registerInstanceListResolver("assets", (orgId, instance, query) =>
    assetsListResolver(orgId, query, instance),
  );
  // Single-entity lookup for an INSTANCE kind ("vehicles:item"). Without it the
  // collection lists fine but every generic single-record read
  // (entities.lookup) returns null — see the records resolver for the failure
  // this caused. lint:instance-resolvers enforces the pair.
  platform().entities.registerInstanceResolver("assets", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instance as never)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedAsset(row);
  });
}

/** Build the watering rule for one asset, or "" if it has no schedule. A raw
 *  metadata.water_rrule wins; otherwise water_every_days → a daily-interval
 *  rule anchored at last_watered (else the asset's created_at). The explicit
 *  DTSTART keeps firing deterministic — rrulestr would otherwise anchor an
 *  interval rule at parse time (non-reproducible across scans). */
function waterRrule(md: Record<string, unknown>, createdAt: unknown): string {
  const raw = md.water_rrule;
  if (typeof raw === "string" && raw.length > 0) return raw;
  const days = Number(md.water_every_days);
  if (!Number.isFinite(days) || days < 1) return "";
  const anchor = icalDate(md.last_watered) ?? icalDate(createdAt) ?? "20200101T000000Z";
  return `DTSTART:${anchor}\nRRULE:FREQ=DAILY;INTERVAL=${Math.floor(days)}`;
}

/** Coerce a date-ish value to an iCal UTC stamp (YYYYMMDDT000000Z), or null. */
function icalDate(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 10).replace(/-/g, "")}T000000Z`;
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
    // Carry the photo so generic surfaces (the labels browser tiles) show it
    // instead of an initial-letter chip. Mirrors inventory's toResolvedPart.
    image_path: (row.image_path as string | null | undefined) ?? undefined,
    fields: row as unknown as Record<string, unknown>,
  };
}
