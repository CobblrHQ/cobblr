// One-shot heal: nothing is inside something that is inside it.
//
// DONE WHEN: no tenant DB has a core_placement_placements chain that comes
// back to where it started. Check with, per tenant:
//   with recursive up(start, at, seen, looped) as (
//     select containee_kind||':'||containee_id, container_kind||':'||container_id,
//            array[containee_kind||':'||containee_id], false from core_placement_placements
//     union all
//     select u.start, p.container_kind||':'||p.container_id, u.seen || u.at, u.at = any(u.seen)
//       from up u join core_placement_placements p on p.containee_kind||':'||p.containee_id = u.at
//      where not u.looped and cardinality(u.seen) < 64)
//   select count(*) from up where at = start;
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its boot call.
//
// BORN WITH: nothing (a fresh workspace has no loop, and the placement lock,
// #9638, keeps any new one from being saved).
//
// WHY IT EXISTS: two things put inside each other at the same moment, before
// the placement lock, were both saved (#9638). Such a workspace still holds
// the loop: neither thing is anywhere, and every read that climbed from either
// went round for ever until #9637 stopped it. The newest move in each loop is
// taken out, the way a person's "take it out" does, so the thing stays and is
// found again, out of the other.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

type Ref = { kind: string; id: string };

/** What a visit reads and writes: the tenant's placements, or a test's memory. */
export interface PlacementLoopsStore {
  /** The newest move among the placements that lead back to themselves, or null. */
  newestMoveInALoop(): Promise<Ref | null>;
  /** Take a thing out of its container through the placement seam. */
  takeOut(thing: Ref): Promise<void>;
}

/** No loop takes more than this many steps to undo: each step breaks one. */
const STEPS_MAX = 64;

/** Heal one workspace; answers how many things were taken out of a loop. */
export async function healPlacementLoopsIn(store: PlacementLoopsStore): Promise<number> {
  let taken = 0;
  for (let i = 0; i < STEPS_MAX; i++) {
    const thing = await store.newestMoveInALoop();
    if (!thing) break;
    await store.takeOut(thing);
    taken++;
  }
  return taken;
}

const exists = async (db: Kysely<unknown>, table: string) =>
  ((await sql<{ ok: boolean }>`select to_regclass(${`public.${table}`}) is not null as ok`.execute(db)).rows[0]?.ok ?? false);

export function kyselyPlacementLoopsStore(orgId: string, db: Kysely<unknown>, since: Date): PlacementLoopsStore {
  return {
    newestMoveInALoop: async () => {
      if (!(await exists(db, "core_placement_placements"))) return null;
      const rows = await sql<{ kind: string; id: string }>`
        with recursive up(start_kind, start_id, at, seen, looped) as (
          select containee_kind, containee_id, container_kind || ':' || container_id,
                 array[containee_kind || ':' || containee_id], false
            from core_placement_placements
          union all
          select u.start_kind, u.start_id, p.container_kind || ':' || p.container_id, u.seen || u.at, u.at = any(u.seen)
            from up u
            join core_placement_placements p on p.containee_kind || ':' || p.containee_id = u.at
           where not u.looped and cardinality(u.seen) < 64
        )
        select p.containee_kind as kind, p.containee_id as id
          from core_placement_placements p
         where p.placed_at < ${since}
           and exists (select 1 from up u where u.start_kind = p.containee_kind and u.start_id = p.containee_id
                         and u.at = p.containee_kind || ':' || p.containee_id)
         order by p.placed_at desc
         limit 1`.execute(db);
      return rows.rows[0] ?? null;
    },
    takeOut: (thing) => platform().placement.remove({ orgId, containee: thing }),
  };
}

/** Call from boot. A registered pass: the kernel's walk and budget. */
export function registerPlacementLoopsHeal(): void {
  registerHealPass({
    name: "placement.heal-loops",
    since: "2026-11-19T22:00:00Z",
    shim: "api/src/platform/heal-placement-loops.ts",
    visit: async ({ orgId, db, since }) => {
      const n = await healPlacementLoopsIn(kyselyPlacementLoopsStore(orgId, db as Kysely<unknown>, since));
      if (n) console.log(`[placement] org ${orgId}: took ${n} thing${n === 1 ? "" : "s"} out of a loop of things inside each other`);
      return n;
    },
  });
}
