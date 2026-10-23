// One-shot heal: remove the matches that point at a catalog entry deleted
// with its catalog before the delete took its matches with it.
//
// DONE WHEN: no entity_pairings row with relationship_kind = 'matches' and
// target_kind = 'core-catalogs:entry' names an entry that is not in its
// tenant's core_catalogs_entries. Check prod, staging and dev, then delete
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
    const live = new Set((await db.selectFrom("core_catalogs_entries").select("id").where("id", "in", targets).execute()).map((e) => e.id));
    const gone = targets.filter((t) => !live.has(t));
    if (gone.length) found += (await platform().pairings.removeByTargets({ orgId, targetKind: KIND, targetIds: gone, relationshipKind: REL })).removed;
    if (targets.length < PAGE) return found;
  }
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
