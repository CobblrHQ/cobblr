// One-shot heal: fold instance-kind ledger rows onto the base kind.
//
// DONE WHEN: no tenant DB has a core_cadence_events row whose entity_kind is an
// instance kind ("<name>:item" for an instance that exists in that workspace).
// Check with, per tenant:
//   select entity_kind, count(*) from core_cadence_events
//    where entity_kind like '%:item' group by 1;
// When that is empty on prod, staging and dev, delete this file and its boot
// call. The write path (record.ts, every door) normalises now, so nothing re-creates them.
//
// WHY IT EXISTS: callers held the presentation kind and the insert stored it
// verbatim, so an item scanned into a skinned table filed its purchases under
// "tea:item" while the shopping-list wire filed the same item's under
// "inventory:part". One entity, two ledgers, and every reader saw whichever half
// it happened to ask for. A workspace where that had happened would otherwise
// keep both halves forever: the new write path stops the split growing but does
// not merge what is already there, and a half ledger reads as a confident wrong
// cadence rather than as an error.

import { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

interface HealDB {
  core_cadence_events: { entity_kind: string; entity_id: string };
}

/** Heal one workspace; answers how many rows it folded. */
export async function healCadenceInstanceKindsIn(orgId: string, db: Kysely<HealDB>): Promise<number> {
  const stray = await db
    .selectFrom("core_cadence_events")
    .select(["entity_kind"])
    .distinct()
    .where("entity_kind", "like", "%:item")
    .execute();
  if (stray.length === 0) return 0; // the happy path: one query, no writes
  let healed = 0;
  for (const { entity_kind } of stray) {
    const base = await platform().entities.baseKindOf(orgId, entity_kind);
    if (base === entity_kind) continue; // not an instance kind after all
    const r = await db.updateTable("core_cadence_events").set({ entity_kind: base }).where("entity_kind", "=", entity_kind).executeTakeFirst();
    const n = Number(r.numUpdatedRows ?? 0);
    if (n > 0) {
      healed += n;
      console.log(`[core-cadence] org ${orgId}: folded ${n} ${entity_kind} row(s) onto ${base}`);
    }
  }
  // Every instance-kind row it meets is folded, so what it folded is what it
  // found; a "<x>:item" kind that turns out to be a base kind is not the
  // shape the DONE WHEN names.
  return healed;
}

/** Call from onBoot. A registered pass (platform-contract heal-pass.ts): the
 *  kernel's walk, budget and stagger, never a walk of its own at boot. */
export function registerCadenceInstanceKindsHeal(): void {
  registerHealPass({
    name: "core-cadence.heal-instance-kinds",
    shim: "modules/core-cadence/src/heal-instance-kinds.ts",
    module: "core-cadence",
    visit: ({ orgId, db }) => healCadenceInstanceKindsIn(orgId, db as Kysely<HealDB>),
  });
}
