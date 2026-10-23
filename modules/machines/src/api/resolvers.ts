import { groupListRows } from "@cobblr/platform-contract/grouped-list";
import { columnSet, platform, withPlaceNames, parseSort, type EntityListQuery, type ResolvedEntity, textSearchWhere } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";
import { resolveDetailPath } from "@cobblr/platform-contract/instance-detail";
import { DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";
import { liftUnits, unitIdsIn, unitsSummary } from "./units.js";

// Native columns the list resolver will order by. Anything outside this set
// (custom metadata fields, unknown keys) is dropped by parseSort rather than
// interpolated into SQL. Mirrors the NATIVE/COMPARABLE whitelists below.
const SORTABLE = columnSet<MachinesDB["machines_machines"]>()([
  "name",
  "state",
  "family",
  "type",
  "manufacturer",
  "excitement",
  "created_at",
  "updated_at",
]);

// A machine in one of these states has left the fleet: it keeps its page and
// its history, and nothing should schedule work for it (ResolvedEntity.retired).
export const GONE_STATES: ReadonlySet<string> = new Set<string>([...Object.values(DISPOSITION_LABELS), "decommissioned"]);

let registered = false;

export function registerMachinesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().placement.registerInsuranceDetails("machines:machine", async (orgId, ids) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const rows = await db.selectFrom("machines_machines").select(["id", "serial_number"]).where("id", "in", ids).execute();
    return new Map(rows.map((r) => [r.id, { serial: r.serial_number }]));
  });

  platform().entities.registerResolver("machines:machine", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const row = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return (await withPlaceNames(orgId, "machines:machine", [toResolvedMachine(await withUnits(orgId, db, row))]))[0]!;
  });

  // Shared list body — base kind (all instances) AND, with an `instance` arg,
  // one multi-instance collection ("3d-printers" vs "laser-cutters"). The
  // instance is a native column, so the generic instance layer (views, the
  // labels browser) can list a single instance through `<instance_name>:item`.
  const listMachines = async (
    orgId: string,
    query: EntityListQuery,
    instance?: string,
  ) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("machines_machines").selectAll();
    if (instance) {
      q = q.where("instance", "=", instance);
      const units = await unitIdsIn(db, orgId, instance);
      if (units.length) q = q.where("id", "not in", units);
    }
    // A machine that left the fleet is out of the list, as the contract has
    // every kind do (EntityListQuery.include_retired), unless the query asks
    // or names the state itself (a "Sold" view does).
    const namesState = query.include_retired === true || query.filter?.state !== undefined;
    if (!namesState) q = q.where((eb) => eb.or([eb("state", "is", null), eb(sql<string>`lower(state)`, "not in", [...GONE_STATES])]));
    if (query.q?.trim()) q = q.where((eb) => textSearchWhere(eb, query.q, { unreadable: query.unreadable, text: ["name", "short_name", "manufacturer", "type", "family", "notes", "state"], json: ["metadata"] })!);
    if (query.filter) {
      const NATIVE = columnSet<MachinesDB["machines_machines"]>()(["state", "family", "type", "manufacturer", "serial_number", "location_id"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'machines'
              and a.source_type = 'machine'
              and a.source_id = machines_machines.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          // Array value → IN (the contract's "IN for arrays" convention), which
          // is how a multi-state filter ("on the workbench" = building OR
          // rebuilding OR …) reaches the resolver. Scalar → equality.
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
    // D10: comparison predicates on numeric / date columns.
    if (query.where) {
      const COMPARABLE = columnSet<MachinesDB["machines_machines"]>()(["excitement", "quantity", "created_at", "updated_at"]);
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
    // Honor the view config's sort spec (native cols only, via SORTABLE);
    // fall back to name A→Z when no usable sort was given. A trailing `name`
    // tiebreak keeps ordering stable when the primary key has ties.
    const order = parseSort(query.sort, SORTABLE);
    for (const { col, dir } of order) q = q.orderBy(col as never, dir);
    if (!order.some((o) => o.col === "name")) q = q.orderBy("name", "asc");
    const rows = (await groupListRows(db, q, query)) ?? await q.limit(limit).offset(offset).execute();
    // A unit is one of its parent's N, not a machine of its own: it leaves the
    // list and rides on its parent, so a count of records never counts it twice.
    // Where each one is, by name, so a search or the assistant can say it.
    return { items: await withPlaceNames(orgId, "machines:machine", (await liftUnits(db, orgId, rows)).map((r) => toResolvedMachine(r))) };
  };

  // Scoped to the default instance - same leak as inventory's base kind; see
  // the note there. A 3D Printers instance's fleet must not double up here.
  platform().entities.registerListResolver("machines:machine", (orgId, query) =>
    listMachines(orgId, query, "machines"),
  { tags: true });
  // Multi-instance: `<instance_name>:item` lists just that instance's machines.
  // Mirrors inventory/assets so a named machines instance (3D Printers) is
  // listable through the generic layer — what the labels browser uses.
  platform().entities.registerInstanceListResolver("machines", (orgId, instance, query) =>
    listMachines(orgId, query, instance),
  { tags: true });
  // …and the single-entity half. Registering only the list resolver is a trap:
  // the collection renders (that IS the list) while every generic single-record
  // read — entities.lookup("<instance>:item", id) — returns null, silently. See
  // the records resolver for the failure this caused. lint:instance-resolvers
  // now enforces the pair.
  platform().entities.registerInstanceResolver("machines", async (orgId, instance, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const row = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instance as never)
      .executeTakeFirst();
    if (!row) return null;
    return (await withPlaceNames(orgId, "machines:machine", [toResolvedMachine(await withUnits(orgId, db, row))]))[0]!;
  });
}

/** One record read on its own: the units it names, how many of its quantity
 *  are not named yet, and, for a unit, which machine it is one of. */
async function withUnits<T extends { id: string; instance: string }>(orgId: string, db: Kysely<MachinesDB>, row: T) {
  const s = await unitsSummary({ db, orgId, userId: null, instance: row.instance }, row.id);
  return { ...row, units: s?.units ?? [], units_not_named: s?.not_named ?? 0, unit_of: s?.unit_of ?? null };
}

function toResolvedMachine(row: {
  id: string;
  name: string;
  state: string;
  instance?: string | null;
  [k: string]: unknown;
}): ResolvedEntity {
  // A machine in a named instance ("3d-printers") lives at the instance's clean
  // URL, opened via ?machine=<id>; only the DEFAULT collection uses /machines.
  // Cross-module "open this machine" links (e.g. a fleet tile) read this, so it
  // must point at the collection the record actually belongs to.
  const detailUrl = resolveDetailPath({
    kind: "machines:machine",
    id: row.id,
    instance: row.instance && row.instance !== "machines" ? row.instance : null,
    detailUrl: null,
    baseDetailRoute: "/machines/{id}",
  })!;
  return {
    kind: "machines:machine",
    id: row.id,
    instance: row.instance && row.instance !== "machines" ? row.instance : null,
    title: row.name,
    subtitle: row.state,
    detailUrl,
    ...(GONE_STATES.has(String(row.state ?? "").toLowerCase()) ? { retired: true } : {}),
    // Carry the photo so generic surfaces (the labels browser tiles) show it
    // instead of an initial-letter chip. Mirrors inventory's toResolvedPart.
    image_path: (row.image_path as string | null | undefined) ?? undefined,
    fields: row as unknown as Record<string, unknown>,
  };
}
