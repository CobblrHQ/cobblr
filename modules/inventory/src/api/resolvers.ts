// Entity-kind resolvers — the in-process bridge between
// platform.entities.lookup() and our tenant tables. Other modules
// (and the platform itself) call platform().entities.lookup(orgId,
// "inventory:part", id) and the platform routes here.

import { sql, type Kysely } from "kysely";
import { platform, type EntityListQuery, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import { type InventoryDB } from "../db.js";
import { applyPartFilters, applyPartSort } from "./part-query.js";

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
      return toResolvedPart(
        row,
        (await categoryNames(db, [row])).get(row.category_id ?? "") ?? null,
        (await locationNames(orgId, [row])).get(row.location_id ?? "") ?? null,
      );
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
    let q = db.selectFrom("inventory_parts").selectAll();
    if (instance) q = q.where("instance", "=", instance as never);
    // Out of use is out of the list, as on the module's own list, unless the
    // query names `archived` itself (a "Retired tools" view does). A saved
    // view on the dashboard listed the opened skein beside the yarn it was
    // opened from, because the unit is kept out of the way as archived and
    // this door had no default (#2848).
    const namesArchived =
      query.include_retired === true || query.filter?.archived !== undefined || (query.where ?? []).some((p) => p.col === "archived");
    if (!namesArchived) q = q.where("archived", "=", false);
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "description", "manufacturer", "notes", "state", "unit"], json: ["metadata"] })!);
    q = applyPartFilters(q, query);
    const sortedQ = applyPartSort(q, query.sort);
    const rows = await sortedQ.limit(limit).offset(offset).execute();
    const [names, places] = await Promise.all([categoryNames(db, rows), locationNames(orgId, rows)]);
    return {
      items: rows.map((r) => toResolvedPart(r, names.get(r.category_id ?? "") ?? null, places.get(r.location_id ?? "") ?? null)),
    };
  };
  // SCOPED TO THE DEFAULT INSTANCE, deliberately. This used to pass no
  // instance, which made the base kind a silent union of EVERY instance's
  // rows: a workspace with a Groceries table saw its groceries a second time
  // under plain Inventory - "Inventory - What's on hand" listed three items
  // while the Inventory page itself showed zero, because the module CRUD
  // scopes to the default instance and this resolver did not. Two doors, one
  // workspace, contradictory counts - and the documented contract ("instances
  // never mix") broken on the door views/search/AI all read through.
  platform().entities.registerListResolver("inventory:part", (orgId, query) =>
    partsListResolver(orgId, query, "inventory"),
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
    return toResolvedPart(
      row,
      (await categoryNames(db, [row])).get(row.category_id ?? "") ?? null,
      (await locationNames(orgId, [row])).get(row.location_id ?? "") ?? null,
    );
  });
}

/** The names of the places these rows live in, one batched lookup through
 *  the platform (the locations are another module's records, so no table
 *  read). "Where is my lamp" was answered with the collection because the
 *  resolved record carried a location id and no name (2026-09-13). */
async function locationNames(
  orgId: string,
  rows: ReadonlyArray<{ location_id?: string | null }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.location_id).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  try {
    const found = await platform().entities.lookupMany(orgId, ids.map((id) => ({ kind: "core-locations:location", id })));
    return new Map(found.map((l) => [l.id, l.title]));
  } catch {
    return new Map(); // a name is never worth failing a read over
  }
}

/** The names of the categories these rows are filed under, one query. Kept
 *  out of the part queries themselves: a join there would make every
 *  unqualified column in the filter dialects ambiguous (both tables have a
 *  name), and a category is a lookup, not a filter. */
async function categoryNames(
  db: Kysely<InventoryDB>,
  rows: ReadonlyArray<{ category_id?: string | null }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.category_id).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const cats = await db.selectFrom("inventory_categories").select(["id", "name"]).where("id", "in", ids).execute();
  return new Map(cats.map((c) => [c.id, c.name]));
}

export function toResolvedPart(row: {
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
  approximate_qty?: string | null;
  estimated_at?: Date | null;
  metadata: unknown;
  archived?: boolean;
  category_id?: string | null;
}, categoryName: string | null = null, locationName: string | null = null): ResolvedEntity {
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
    // Archived is inventory's word for "out of use". Reported generically so a
    // sweeper in another module can honour it without knowing this table.
    ...(row.archived ? { retired: true } : {}),
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
      // What it is filed under, by name. Rice under Grocery IS grocery: a
      // view, a search, the assistant and the no-AI move planner all read a
      // record through here, and none of them could tell until this was said.
      // Named as the parts list route names it, so the two shapes stay one.
      category_name: categoryName,
      // Where it lives — the scan "already tracked" banner shows it, and
      // move-mode uses it to skip entities already in the active bin. Named
      // too, as the parts list route names it: the assistant reads a record
      // through here and cannot say a uuid, so without the name "where is my
      // lamp" was answered with the collection (2026-09-13).
      location_id: row.location_id ?? null,
      location_name: locationName,
      // An estimate, when this record stands for "roughly this many, jumbled".
      // Exposed through the resolver so a CONTAINER can roll its contents up
      // ("10 kinds, roughly 50") without inventory-specific knowledge, and so
      // the card can pick its shape from the signal rather than being told.
      approximate_qty: row.approximate_qty == null ? null : Number(row.approximate_qty),
      estimated_at: row.estimated_at ?? null,
      metadata: row.metadata,
    },
  };
}
