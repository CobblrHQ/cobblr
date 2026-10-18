// One-shot heal: one home per record, under the record's base kind.
//
// DONE WHEN: no tenant DB has a core_placement_placements row whose
// containee_kind or container_kind is an instance kind ("<name>:item" for a
// collection that exists in that workspace). Check with, per tenant:
//   select containee_kind, container_kind, count(*) from core_placement_placements
//    where containee_kind like '%:item' or container_kind like '%:item' group by 1, 2;
// When that is empty on prod, staging and dev, delete this file and its
// onBoot call. The kernel (platform().placement, every door) keys by the base
// kind at entry now, so nothing re-creates them.
//
// BORN WITH: nothing (a workspace made after the kernel fix writes every
// placement through platform().placement, which stores the base kind, so it
// cannot hold a row under a collection's kind).
//
// WHY IT EXISTS: a placement was stored under the kind as the caller spelled
// it. The record page and the location trigger wrote "inventory:part"; the
// assistant, holding a search result, wrote "home-inventory:item" for the
// same record. The upsert keyed on the spelling did not collide, so a desk
// fan placed in the Bedroom and moved to the Garage had two rows: in both
// places at once, listed twice in a container, and invisible to a lookup made
// with the other spelling (#3663). This folds each collection-kind row onto
// the base kind, and where one record has a row under each, keeps the newest
// placement, which is the move the person made last.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

interface HealDB {
  core_placement_placements: {
    containee_kind: string;
    containee_id: string;
    container_kind: string;
    container_id: string;
    placed_at: unknown;
  };
}

/** Heal one workspace; answers how many rows it folded or dropped. */
export async function healPlacementKindsIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  const stray = await db
    .selectFrom("core_placement_placements")
    .select(["containee_kind", "container_kind"])
    .distinct()
    .where("placed_at", "<", since)
    .where((eb) => eb.or([eb("containee_kind", "like", "%:item"), eb("container_kind", "like", "%:item")]))
    .execute();
  if (stray.length === 0) return 0; // the happy path: one query, no writes
  const kinds = new Set(stray.flatMap((r) => [r.containee_kind, r.container_kind]).filter((k) => k.endsWith(":item")));
  let healed = 0;
  for (const kind of kinds) {
    const base = await platform().entities.baseKindOf(orgId, kind);
    if (base === kind) continue; // not an instance kind after all
    await db.transaction().execute(async (trx) => {
      // The same record under both spellings: the newer placement stands.
      const olderInstance = await sql`
        delete from core_placement_placements a using core_placement_placements b
         where a.containee_kind = ${kind} and b.containee_kind = ${base}
           and a.containee_id = b.containee_id and a.placed_at <= b.placed_at and a.placed_at < ${since}`.execute(trx);
      const olderBase = await sql`
        delete from core_placement_placements b using core_placement_placements a
         where a.containee_kind = ${kind} and b.containee_kind = ${base}
           and a.containee_id = b.containee_id and a.placed_at > b.placed_at and a.placed_at < ${since}`.execute(trx);
      const folded = await trx.updateTable("core_placement_placements").set({ containee_kind: base }).where("containee_kind", "=", kind).where("placed_at", "<", since).executeTakeFirst();
      const asContainer = await trx.updateTable("core_placement_placements").set({ container_kind: base }).where("container_kind", "=", kind).where("placed_at", "<", since).executeTakeFirst();
      const n =
        Number(olderInstance.numAffectedRows ?? 0) +
        Number(olderBase.numAffectedRows ?? 0) +
        Number(folded.numUpdatedRows ?? 0) +
        Number(asContainer.numUpdatedRows ?? 0);
      if (n > 0) console.log(`[core-placement] org ${orgId}: folded ${n} ${kind} placement row(s) onto ${base}`);
      healed += n;
    });
  }
  return healed;
}

/** Call from onBoot. A registered pass (platform-contract heal-pass.ts): the
 *  kernel's walk, budget and stagger, never a walk of its own at boot. */
export function registerPlacementKindsHeal(): void {
  registerHealPass({
    name: "core-placement.heal-instance-kinds",
    since: "2026-09-24T22:50:06Z",
    shim: "modules/core-placement/src/heal-instance-kinds.ts",
    module: "core-placement",
    visit: ({ orgId, db, since }) => healPlacementKindsIn(orgId, db as Kysely<HealDB>, since),
  });
}
