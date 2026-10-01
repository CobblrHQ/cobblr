import { columnSet, placeNames as placeNamesOf, platform, parseSort, textSearchWhere, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { AssetsDB } from "../db.js";
import { amountOf, toCents } from "@cobblr/platform-contract/money";

let registered = false;

// Native columns the list resolver will order by; anything else is dropped by
// parseSort rather than reaching SQL. Union of the NATIVE/COMPARABLE filter
// whitelists below plus name.
const SORTABLE = columnSet<AssetsDB["assets_assets"]>()([
  "name",
  "state",
  "type",
  "manufacturer",
  "location_id",
  "excitement",
  "quantity",
  "purchased_at",
  "purchase_price_cents",
  "vendor",
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
      .where("archived_at", "is", null)
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

  // What an asset is worth: what was paid for it. Once parts are installed
  // in it, that is its value besides them ("other value, not itemized"), and
  // its total adds the parts, each counted once (placement.builtValue).
  platform().placement.registerValue("assets:asset", async (orgId, ids) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    let q = db.selectFrom("assets_assets").select(["id", "purchase_price_cents"]).where("purchase_price_cents", "is not", null);
    q = ids === "all" ? q.where("archived_at", "is", null) : q.where("id", "in", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const rows = await q.execute();
    return new Map(rows.map((r) => [r.id, amountOf(toCents(Number(r.purchase_price_cents)))]));
  });

  platform().entities.registerResolver("assets:asset", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedAsset(row, (await placeNamesOf(orgId, "assets:asset", [row])).get(row.id) ?? null);
  });

  const assetsListResolver = async (orgId: string, query: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<AssetsDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    // An archived thing is put away: not in a view, search or Needs you.
    let q = db.selectFrom("assets_assets").selectAll().where("archived_at", "is", null);
    if (instance) q = q.where("instance", "=", instance as never);
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "short_name", "manufacturer", "model", "serial_number", "type", "notes", "state"], json: ["metadata"] })!);
    if (query.filter) {
      const NATIVE = columnSet<AssetsDB["assets_assets"]>()(["state", "location_id", "type", "manufacturer"]);
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
      const COMPARABLE = columnSet<AssetsDB["assets_assets"]>()([
        "purchased_at",
        "purchase_price_cents",
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
    const places = await placeNamesOf(orgId, "assets:asset", rows);
    return { items: rows.map((r) => toResolvedAsset(r, places.get(r.id) ?? null)) };
  };
  // Scoped to the default instance - same leak as inventory's base kind; see
  // the note there. A Vehicles instance's cars must not double up under Assets.
  platform().entities.registerListResolver("assets:asset", (orgId, query) =>
    assetsListResolver(orgId, query, "assets"),
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
    return toResolvedAsset(row, (await placeNamesOf(orgId, "assets:asset", [row])).get(row.id) ?? null);
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
}, locationName: string | null = null): ResolvedEntity {
  return {
    kind: "assets:asset",
    id: row.id,
    title: row.name,
    subtitle: row.state,
    // Carry the photo so generic surfaces (the labels browser tiles) show it
    // instead of an initial-letter chip. Mirrors inventory's toResolvedPart.
    image_path: (row.image_path as string | null | undefined) ?? undefined,
    fields: { ...(row as unknown as Record<string, unknown>), location_name: locationName },
    // Put away: it still resolves, and nothing generates work for it.
    ...(row.archived_at ? { retired: true } : {}),
  };
}
