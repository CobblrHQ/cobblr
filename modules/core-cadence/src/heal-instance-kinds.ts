// One-shot heal: fold instance-kind ledger rows onto the base kind.
//
// DONE WHEN: no tenant DB has a core_cadence_events row whose entity_kind is an
// instance kind ("<name>:item" for an instance that exists in that workspace).
// Check with, per tenant:
//   select entity_kind, count(*) from core_cadence_events
//    where entity_kind like '%:item' group by 1;
// When that is empty on prod, staging and dev, delete this file and its boot
// call. The write path (api/index.ts) normalises now, so nothing re-creates them.
//
// WHY IT EXISTS: callers held the presentation kind and the insert stored it
// verbatim, so an item scanned into a skinned table filed its purchases under
// "tea:item" while the shopping-list wire filed the same item's under
// "inventory:part". One entity, two ledgers, and every reader saw whichever half
// it happened to ask for. A workspace where that had happened would otherwise
// keep both halves forever: the new write path stops the split growing but does
// not merge what is already there, and a half ledger reads as a confident wrong
// cadence rather than as an error.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

interface HealDB {
  core_cadence_events: { entity_kind: string; entity_id: string };
}

export async function healCadenceInstanceKinds(): Promise<{ orgs: number; rows: number }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;

  // Only workspaces that actually have the capability on: everyone else has no
  // table to sweep and must not cost a tenant pool.
  const orgs = await meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("module_name", "=", "core-cadence")
    .execute();

  let healed = 0;
  let touched = 0;
  for (const { org_id } of orgs) {
    try {
      await platform().tenants.withDb(org_id, async (raw) => {
        const db = raw as Kysely<HealDB>;
        const stray = await db
          .selectFrom("core_cadence_events")
          .select(["entity_kind"])
          .distinct()
          .where("entity_kind", "like", "%:item")
          .execute();
        if (stray.length === 0) return; // the happy path: one query, no writes

        for (const { entity_kind } of stray) {
          const base = await platform().entities.baseKindOf(org_id, entity_kind);
          if (base === entity_kind) continue; // not an instance kind after all
          const r = await db
            .updateTable("core_cadence_events")
            .set({ entity_kind: base })
            .where("entity_kind", "=", entity_kind)
            .executeTakeFirst();
          const n = Number(r.numUpdatedRows ?? 0);
          if (n > 0) {
            healed += n;
            console.log(`[core-cadence] org ${org_id}: folded ${n} ${entity_kind} row(s) onto ${base}`);
          }
        }
        touched++;
      });
    } catch (err) {
      // One workspace's failure must never block the rest.
      console.error(`[core-cadence] heal for org ${org_id} failed:`, (err as Error).message);
    }
  }
  if (healed > 0) console.log(`[core-cadence] heal: ${healed} row(s) across ${touched} workspace(s)`);
  return { orgs: touched, rows: healed };
}

// Referenced so the unused-import lint and a reader both see the intent.
void sql;
