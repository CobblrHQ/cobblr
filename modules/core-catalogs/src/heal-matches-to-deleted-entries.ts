// One-shot heal: remove the matches that point at a catalog entry deleted
// with its catalog before the delete took its matches with it.
//
// DONE WHEN: no entity_pairings row with relationship_kind = 'matches' and
// target_kind = 'core-catalogs:entry' names an entry that is not in its
// tenant's core_catalogs_entries, or a hosted entry (`<catalog>::<id>`) whose
// catalog is not in core_catalogs_catalogs. Check prod, staging and dev, then delete
// this file and its onBoot call.
//
// BORN WITH: DELETE /catalogs/:id removes the matches pointing at the
// catalog's entries (pairings.removeByTargets) in the same request, so a
// catalog deleted now leaves none.
//
// WHY IT EXISTS: the entries went with their catalog and the matches stayed,
// so every matched item kept asking for an entry that was gone and got a 404
// (#7918).

import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreCatalogsDB } from "./db.js";

const KIND = "core-catalogs:entry";
const REL = "matches";
const PAGE = 1000;

export async function healMatchesToDeletedEntries(orgId: string, db: Kysely<CoreCatalogsDB>, since: Date): Promise<number> {
  let found = 0;
  let after: string | undefined;
  for (;;) {
    const targets = await platform().pairings.listTargets({ orgId, targetKind: KIND, relationshipKind: REL, madeBefore: since, ...(after ? { afterTargetId: after } : {}), limit: PAGE });
    if (!targets.length) return found;
    after = targets[targets.length - 1];
    const gone = await goneTargets(db, targets);
    if (gone.length) found += (await platform().pairings.removeByTargets({ orgId, targetKind: KIND, targetIds: gone, relationshipKind: REL })).removed;
    if (targets.length < PAGE) return found;
  }
}

// A stored entry is named by its uuid; a hosted-search match by
// `<catalog id>::<external id>`, whose entry lives in the hosted dataset, so only
// its catalog can be checked here. Any other shape is left alone.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function goneTargets(db: Kysely<CoreCatalogsDB>, targets: string[]): Promise<string[]> {
  const entryIds = targets.filter((t) => UUID.test(t));
  const hostedCatalog = new Map<string, string>();
  for (const t of targets) {
    const catalogId = t.split("::")[0]!;
    if (t.includes("::") && UUID.test(catalogId)) hostedCatalog.set(t, catalogId);
  }
  const catalogIds = [...new Set(hostedCatalog.values())];
  const liveEntries = new Set(entryIds.length ? (await db.selectFrom("core_catalogs_entries").select("id").where("id", "in", entryIds).execute()).map((e) => e.id) : []);
  const liveCatalogs = new Set(catalogIds.length ? (await db.selectFrom("core_catalogs_catalogs").select("id").where("id", "in", catalogIds).execute()).map((c) => c.id) : []);
  return targets.filter((t) => (UUID.test(t) ? !liveEntries.has(t) : hostedCatalog.has(t) && !liveCatalogs.has(hostedCatalog.get(t)!)));
}

export function registerMatchesToDeletedEntriesHeal(): void {
  registerHealPass({
    name: "core-catalogs.heal-matches-to-deleted-entries",
    since: "2026-10-22T14:00:00Z",
    shim: "modules/core-catalogs/src/heal-matches-to-deleted-entries.ts",
    module: "core-catalogs",
    visit: ({ orgId, db, since }) => healMatchesToDeletedEntries(orgId, db as Kysely<CoreCatalogsDB>, since),
  });
}
