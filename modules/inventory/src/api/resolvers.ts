// Entity-kind resolvers — the in-process bridge between
// platform.entities.lookup() and our tenant tables. Other modules
// (and the platform itself) call platform().entities.lookup(orgId,
// "inventory:part", id) and the platform routes here.

import { sql, type Kysely } from "kysely";
import { platform, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

export function registerInventoryResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver(
    "inventory:part",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toResolvedPart(row);
    },
  );

  // List resolver — lets core-views (and future search) iterate the
  // kind without each consumer learning the inventory_parts table
  // shape. Supports limit/offset, optional free-text q on name +
  // description, and three filter dialects:
  //   filter.<top-level col>  → WHERE col = value          (native)
  //   filter._tag             → join through tags (D7)
  //   filter.<anything else>  → WHERE metadata ->> key = value (D8)
  // Shared parts list — used for the base `inventory:part` kind (all parts)
  // and, with an `instance` arg, for any inventory instance kind
  // (`<name>:item`), scoped to that instance's parts.
  const partsListResolver = async (orgId: string, query: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    const NATIVE_FILTER_COLS = new Set(["category_id", "location_id", "state"]);
    let q = db.selectFrom("inventory_parts").selectAll();
    if (instance) q = q.where("instance", "=", instance as never);
    if (query.q && query.q.length > 0) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(eb.fn("lower", ["name"]), "like", needle),
          eb(eb.fn("lower", ["description"]), "like", needle),
        ]),
      );
    }
    if (query.filter) {
      const f = query.filter;
      for (const [key, val] of Object.entries(f)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          // D7: every entity carrying this tag (by name). Case-insensitive
          // match against core_tags_tags.name; sub-query joins assignments.
          const tagName = String(val).trim().toLowerCase();
          q = q.where(
            sql<boolean>`exists (
              select 1 from core_tags_assignments a
              join core_tags_tags t on t.id = a.tag_id
              where a.source_module = 'inventory'
                and a.source_type = 'part'
                and a.source_id = inventory_parts.id
                and lower(t.name) = ${tagName}
            )`,
          );
          continue;
        }
        if (NATIVE_FILTER_COLS.has(key)) {
          if (typeof val === "string") {
            q = q.where(key as never, "=", val as never);
          }
          continue;
        }
        // D8: unknown filter key — assume it's a metadata field.
        // Postgres ->> returns text; we coerce val to string for the
        // comparison. JSON values are stored as their JSON form
        // (numbers come back as text representations).
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates. Native numeric/date columns, OR a custom
    // numeric metadata field (a yarn instance's "remaining", a spool's qty) via
    // a guarded cast. Unknown col / unsupported (col, op) silently skipped.
    if (query.where) {
      const COMPARABLE = new Set(["qty", "min_qty", "cost", "created_at", "updated_at"]);
      for (const p of query.where) {
        if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) continue;
        const nativeCol = COMPARABLE.has(p.col);
        if (p.ref_col) {
          // Column-to-column comparisons stay native-only.
          if (!nativeCol || !COMPARABLE.has(p.ref_col)) continue;
          q = q.where(
            sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${sql.ref(p.ref_col)}`,
          );
        } else if (p.value !== undefined) {
          if (nativeCol) {
            const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
            q = q.where(sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${v}`);
          } else if (
            typeof p.value === "number" ||
            (typeof p.value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(p.value))
          ) {
            // Custom numeric metadata field. Guard the cast so a row whose
            // value isn't a plain number (e.g. "1 kg") is excluded, not an
            // error. p.col is bound as a parameter (no injection); the op is
            // whitelisted above.
            const num = Number(p.value);
            q = q.where(
              sql<boolean>`(metadata->>${p.col}) ~ '^-?[0-9]+(\\.[0-9]+)?$' AND (metadata->>${p.col})::numeric ${sql.raw(p.op)} ${num}`,
            );
          }
          // else: non-numeric value on a non-native col → skip.
        }
      }
    }
    // Sort: default by name asc. Whitelist sortable columns so a
    // bad config can't blow up the query.
    const sortable = new Set(["name", "qty", "created_at", "updated_at"]);
    const sortSpecs = (query.sort ?? ["name"]).filter((s) =>
      sortable.has(s.replace(/^-/, "")),
    );
    let sortedQ = q;
    for (const spec of sortSpecs) {
      const desc = spec.startsWith("-");
      const col = spec.replace(/^-/, "");
      sortedQ = sortedQ.orderBy(col as never, desc ? "desc" : "asc");
    }
    const rows = await sortedQ.limit(limit).offset(offset).execute();
    return {
      items: rows.map((r) => toResolvedPart(r)),
    };
  };
  platform().entities.registerListResolver("inventory:part", (orgId, query) =>
    partsListResolver(orgId, query),
  );
  // Instance kinds (`<name>:item`) → this module's parts scoped to the instance.
  // Lets a Wardrobe/Filament/… instance's items flow through views/data/search.
  platform().entities.registerInstanceListResolver("inventory", (orgId, instance, query) =>
    partsListResolver(orgId, query, instance),
  );
  // Single-entity twin — a `<name>:item` LOOKUP resolves the part by id scoped to
  // the instance, so instance detail/lookup resolves + gets computed fields the
  // same as the base inventory:part kind.
  platform().entities.registerInstanceResolver("inventory", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instance as never)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedPart(row);
  });
}

function toResolvedPart(row: {
  id: string;
  name: string;
  description: string | null;
  qty: string;
  unit: string;
  cost: string | null;
  min_qty: string | null;
  manufacturer: string | null;
  supplier_url: string | null;
  image_path: string | null;
  notes: string | null;
  instance: string;
  location_id?: string | null;
  metadata: unknown;
}): ResolvedEntity {
  const qty = Number(row.qty);
  // A skinned instance's items live at /instances/<name>/items/:id; the default
  // ("inventory") instance lives at the base /inventory/parts/:id. Without this,
  // clicking an instance item (e.g. a Filament TYPE in `filament-types`) from any
  // surface that uses the resolved detailUrl — a saved view, the dashboard,
  // search — navigated to the base route, which scopes to the default instance →
  // "part not found".
  const detailUrl =
    row.instance && row.instance !== "inventory"
      ? `/instances/${row.instance}/items/${row.id}`
      : `/inventory/parts/${row.id}`;
  return {
    kind: "inventory:part",
    id: row.id,
    title: row.name,
    subtitle: row.manufacturer ?? undefined,
    image_path: row.image_path ?? undefined,
    detailUrl,
    fields: {
      name: row.name,
      description: row.description,
      qty: Number.isFinite(qty) ? qty : 0,
      unit: row.unit,
      cost: row.cost == null ? null : Number(row.cost),
      min_qty: row.min_qty == null ? null : Number(row.min_qty),
      manufacturer: row.manufacturer,
      supplier_url: row.supplier_url,
      image_path: row.image_path,
      notes: row.notes,
      // Where it lives — the scan "already tracked" banner shows it, and
      // move-mode uses it to skip entities already in the active bin.
      location_id: row.location_id ?? null,
      metadata: row.metadata,
    },
  };
}
