// Entity-kind resolvers — the in-process bridge between
// platform.entities.lookup() and our tenant tables. Other modules
// (and the platform itself) call platform().entities.lookup(orgId,
// "inventory:part", id) and the platform routes here.

import { placeNames } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import { platform, type EntityListQuery, type FilterPredicate, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import { type InventoryDB } from "../db.js";
import { applyPartFilters, applyPartSort } from "./part-query.js";
import { readsValues, refreshMeasureReadings } from "../measure-readings.js";
import { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";
import type { Remaining } from "@cobblr/platform-contract/consumption-gauge";
import { remainingFor } from "./remaining.js";
import { annotateInstalled } from "./installed.js";

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
        (await locationNames(orgId, [row])).get(row.id) ?? null,
        (await remainingFor(orgId, db, [row])).get(row.id) ?? null,
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
  const partsListResolver = async (orgId: string, asked: EntityListQuery, instance?: string) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    // "Hide unavailable" is a view filter over what is installed, not a
    // column: taken out before the column filters read it as a field name.
    const { hide_unavailable: hideFlag, ...restFilter } = asked.filter ?? {};
    const hideUnavailable = hideFlag === true || hideFlag === "true" || hideFlag === "1";
    const query: EntityListQuery = { ...asked, ...(asked.filter ? { filter: restFilter } : {}) };
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    if (readsValues(query)) await refreshMeasureReadings(db, { instance });
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
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { text: ["name", "description", "manufacturer", "notes", "state", "unit"], json: ["metadata"], readings: "measures" })!);
    const unapplied: FilterPredicate[] = [];
    q = applyPartFilters(q, query, { unapplied });
    const sortedQ = applyPartSort(q, query.sort);
    // The total is a COUNT over the same filters, not a walk: an assistant's
    // "how many" walked the list a page at a time to a 5000-row cap and said
    // "5000, incomplete" for a workspace it could have counted in one query
    // (#4789). "Hide unavailable" is decided per row below, after the query,
    // so a count would not match it and is left out then.
    const [rows, counted] = await Promise.all([
      sortedQ.limit(limit).offset(offset).execute(),
      hideUnavailable ? Promise.resolve(null) : q.clearSelect().select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirst(),
    ]);
    const [names, places, left, held, inst] = await Promise.all([
      categoryNames(db, rows),
      locationNames(orgId, rows),
      remainingFor(orgId, db, rows),
      reservedFor(db, rows),
      annotateInstalled(orgId, rows.map((r) => ({ id: r.id, qty: Number(r.qty), approximate_qty: r.approximate_qty == null ? null : Number(r.approximate_qty) }))),
    ]);
    const instOf = new Map(inst.map((i) => [i.id, i]));
    const items = rows
      .map((r) => {
        const e = withReserved(toResolvedPart(r, names.get(r.category_id ?? "") ?? null, places.get(r.id) ?? null, left.get(r.id) ?? null), r, held);
        const i = instOf.get(r.id);
        return i ? { ...e, fields: { ...e.fields, installed_qty: i.installed_qty, spare_qty: i.spare_qty, installed_in: i.installed_in } } : e;
      })
      .filter((e) => !hideUnavailable || Number((e.fields as { spare_qty?: unknown }).spare_qty ?? 1) > 0);
    return {
      items,
      ...(counted ? { total: Number(counted.n) } : {}),
      ...(unapplied.length ? { unapplied } : {}),
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
      (await locationNames(orgId, [row])).get(row.id) ?? null,
      (await remainingFor(orgId, db, [row])).get(row.id) ?? null,
    );
  });
}

/** Where each row is, by name. "Where is my lamp" was answered with the
 *  collection because the resolved record carried a location id and no name
 *  (2026-09-13); a thing inside a Backpack has the Backpack's line. */
function locationNames(orgId: string, rows: ReadonlyArray<{ id: string; location_id?: string | null }>): Promise<Map<string, string>> {
  return placeNames(orgId, "inventory:part", rows);
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

/** What is reserved of each row, in ONE query for the page. */
async function reservedFor(db: Kysely<InventoryDB>, rows: readonly { id: string }[]): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const sums = await db
    .selectFrom("inventory_allocations")
    .select(["part_id", sql<string>`sum(qty)`.as("held")])
    .where("status", "=", "reserved")
    .where("part_id", "in", rows.map((r) => r.id))
    .groupBy("part_id")
    .execute();
  return new Map(sums.map((x) => [x.part_id, Number(x.held)]));
}

/** A listed part carries its instance and what of it is free, the figures the
 *  parts list shows (assigned_qty / available_qty), so a reader in another
 *  module (a pattern matching its yarn) sees what the stash page sees. */
function withReserved(e: ResolvedEntity, row: { id: string; qty: string; instance: string }, held: Map<string, number>): ResolvedEntity {
  const assigned = held.get(row.id) ?? 0;
  const qty = Number(row.qty);
  return {
    ...e,
    fields: { ...e.fields, instance: row.instance, assigned_qty: assigned, available_qty: (Number.isFinite(qty) ? qty : 0) - assigned },
  };
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
}, categoryName: string | null = null, locationName: string | null = null, remaining: Remaining | null = null): ResolvedEntity {
  const qty = Number(row.qty);
  // A skinned instance's items live at /instances/<name>/items/:id; the default
  // ("inventory") instance lives at the base /inventory/parts/:id. Without this,
  // clicking an instance item (e.g. a Filament TYPE in `filament-types`) from any
  // surface that uses the resolved detailUrl — a saved view, the dashboard,
  // search — navigated to the base route, which scopes to the default instance →
  // "part not found".
  const namedInstance = row.instance && row.instance !== "inventory" ? row.instance : null;
  const detailUrl = resolveDetailPath({
    kind: "inventory:part",
    id: row.id,
    instance: namedInstance,
    detailUrl: null,
    baseDetailRoute: "/inventory/parts/{id}",
  })!;
  return {
    kind: "inventory:part",
    id: row.id,
    instance: namedInstance,
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
      // What is LEFT, from the running balance (consumption-gauge.ts): the
      // unopened count, each open unit's remainder and, when they add up in
      // one measure, the total. A reader never works it out from a capacity,
      // which is the size of one unit, not what is left (#3651).
      ...(remaining ? { remaining } : {}),
      metadata: row.metadata,
    },
  };
}
