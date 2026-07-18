import { platform, parseSort, type EntityListQuery, type ResolvedEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { MachinesDB } from "../db.js";

// Native columns the list resolver will order by. Anything outside this set
// (custom metadata fields, unknown keys) is dropped by parseSort rather than
// interpolated into SQL. Mirrors the NATIVE/COMPARABLE whitelists below.
const SORTABLE = new Set([
  "name",
  "state",
  "family",
  "type",
  "manufacturer",
  "excitement",
  "created_at",
  "updated_at",
]);

let registered = false;

export function registerMachinesResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("machines:machine", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
    const row = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return toResolvedMachine(row);
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
    if (instance) q = q.where("instance", "=", instance);
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) => eb(eb.fn("lower", ["name"]), "like", needle));
    }
    if (query.filter) {
      const NATIVE = new Set(["state", "family", "type", "manufacturer", "serial_number", "location_id"]);
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
      const COMPARABLE = new Set(["excitement", "quantity", "created_at", "updated_at"]);
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
    const rows = await q.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedMachine(r)) };
  };

  platform().entities.registerListResolver("machines:machine", (orgId, query) =>
    listMachines(orgId, query),
  );
  // Multi-instance: `<instance_name>:item` lists just that instance's machines.
  // Mirrors inventory/assets so a named machines instance (3D Printers) is
  // listable through the generic layer — what the labels browser uses.
  platform().entities.registerInstanceListResolver("machines", (orgId, instance, query) =>
    listMachines(orgId, query, instance),
  );
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
    return toResolvedMachine(row);
  });
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
  const detailUrl =
    row.instance && row.instance !== "machines"
      ? `/${row.instance}?machine=${row.id}`
      : `/machines/${row.id}`;
  return {
    kind: "machines:machine",
    id: row.id,
    title: row.name,
    subtitle: row.state,
    detailUrl,
    // Carry the photo so generic surfaces (the labels browser tiles) show it
    // instead of an initial-letter chip. Mirrors inventory's toResolvedPart.
    image_path: (row.image_path as string | null | undefined) ?? undefined,
    fields: row as unknown as Record<string, unknown>,
  };
}
