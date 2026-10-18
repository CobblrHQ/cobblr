// One-shot heal: nothing points at a place that no longer exists.
//
// DONE WHEN: no tenant DB has a located row (inventory_parts, machines_machines,
// assets_assets, records_records) whose location_id names no
// core_locations_locations row, and no core_placement_placements row whose
// container is a core-locations:location that no longer exists. Check with,
// per tenant and per located table:
//   select count(*) from inventory_parts p where p.location_id is not null
//    and not exists (select 1 from core_locations_locations l where l.id = p.location_id);
//   select count(*) from core_placement_placements p where p.container_kind = 'core-locations:location'
//    and not exists (select 1 from core_locations_locations l where l.id::text = p.container_id);
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its boot call.
//
// BORN WITH: nothing (a fresh workspace has no deleted places, and a place
// deleted from now on is emptied first, by emptyPlaceBeforeDelete).
//
// WHY IT EXISTS: deleting a place used to delete only the location rows (the
// place and, by cascade, every place inside it). A thing's place is a placement
// row plus the legacy location_id, neither with a foreign key to the location,
// so everything kept there went on naming the deleted place (#4115 audit).
// Each such thing is taken out the way a person's "take it out" does: through
// the placement seam when a placement row exists, else through the thing's
// own entity writer, which clears location_id.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { LOCATED_TABLES } from "./located-tables.js";

const LOCATION = "core-locations:location";

/** What a visit reads and writes: the tenant tables, or a test's memory. */
export interface DanglingPlacesStore {
  /** Things whose location_id names a place that no longer exists. */
  strandedByLocationId(): Promise<Array<{ kind: string; id: string }>>;
  /** Things placed in a place that no longer exists. */
  strandedByPlacement(): Promise<Array<{ kind: string; id: string }>>;
  /** Take a thing out through the placement seam (clears location_id too). */
  takeOut(thing: { kind: string; id: string }): Promise<void>;
  /** Clear a location_id no placement row carries. */
  clearLocationId(thing: { kind: string; id: string }): Promise<void>;
}

/** Heal one workspace; answers how many things pointed at a deleted place. */
export async function healDanglingPlacesIn(store: DanglingPlacesStore): Promise<number> {
  const placed = await store.strandedByPlacement();
  for (const thing of placed) await store.takeOut(thing);
  const taken = new Set(placed.map((t) => `${t.kind}:${t.id}`));
  // Read after the placements are gone: taking a thing out already cleared its
  // location_id, so what is left here carried no placement at all.
  const byId = (await store.strandedByLocationId()).filter((t) => !taken.has(`${t.kind}:${t.id}`));
  for (const thing of byId) await store.clearLocationId(thing);
  return placed.length + byId.length;
}

const exists = async (db: Kysely<unknown>, table: string) =>
  ((await sql<{ ok: boolean }>`select to_regclass(${`public.${table}`}) is not null as ok`.execute(db)).rows[0]?.ok ?? false);

export function kyselyDanglingPlacesStore(orgId: string, db: Kysely<unknown>, since: Date): DanglingPlacesStore {
  return {
    strandedByLocationId: async () => {
      if (!(await exists(db, "core_locations_locations"))) return [];
      const out: Array<{ kind: string; id: string }> = [];
      for (const t of LOCATED_TABLES) {
        if (!(await exists(db, t.table))) continue;
        const rows = await sql<{ id: string }>`
          select r.id::text as id from ${sql.table(t.table)} r
           where r.location_id is not null
             and r.created_at < ${since}
             and not exists (select 1 from core_locations_locations l where l.id::text = r.location_id::text)`.execute(db);
        out.push(...rows.rows.map((r) => ({ kind: t.kind, id: r.id })));
      }
      return out;
    },
    strandedByPlacement: async () => {
      if (!(await exists(db, "core_locations_locations")) || !(await exists(db, "core_placement_placements"))) return [];
      const rows = await sql<{ kind: string; id: string }>`
        select p.containee_kind as kind, p.containee_id as id from core_placement_placements p
         where p.container_kind = ${LOCATION}
           and p.placed_at < ${since}
           and not exists (select 1 from core_locations_locations l where l.id::text = p.container_id)`.execute(db);
      return rows.rows;
    },
    takeOut: (thing) => platform().placement.remove({ orgId, containee: thing }),
    clearLocationId: async (thing) => {
      const writer = await platform().entities.getWriter(orgId, thing.kind);
      if (writer) await writer.update(orgId, thing.id, { location_id: null });
    },
  };
}

/** Call from boot. A registered pass: the kernel's walk and budget. */
export function registerDanglingPlacesHeal(): void {
  registerHealPass({
    name: "placement.heal-dangling-places",
    since: "2026-09-30T13:29:02Z",
    shim: "api/src/platform/heal-dangling-places.ts",
    visit: async ({ orgId, db, since }) => {
      const n = await healDanglingPlacesIn(kyselyDanglingPlacesStore(orgId, db as Kysely<unknown>, since));
      if (n) console.log(`[placement] org ${orgId}: took ${n} thing${n === 1 ? "" : "s"} out of places that no longer exist`);
      return n;
    },
  });
}
