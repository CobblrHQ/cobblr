// One-shot heal: a waiting scan's suggested place that nothing about the item
// stood behind is withdrawn (#4933).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row with a
// suggested_location_id, no target_location_id, and a note that either has no
// reason or gives the catch-all table's habit for a row routed to a module's
// own table. Check with, per tenant:
//   select count(*) from core_scan_inbox_items
//    where status = 'pending' and target_location_id is null
//      and suggested_location_id is not null
//      and (coalesce(suggested_location_note, '') !~ '\s[–—-]\s\S'
//           or ((suggested_location_note ~ '\s[–—-]\swhere your other .+ are$'
//                or suggested_location_note ~ '\s[–—-]\s[0-9]+ others are kept here$')
//               and coalesce(suggested_candidates->0->>'instance', '') = ''));
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call.
//
// BORN WITH: nothing (a suggestion is now written only with item-level
// evidence: suggest-location.ts skips the same-collection tier for a module's
// own table, and every tier carries its reason).
//
// WHY IT EXISTS: an Amazon sticker routed to Inventory was offered "Top
// Cabinet 1 — where your other Inventory are", the catch-all table's most
// common place, and File all would have filed it there. The owner could not
// tell why it was there. Rows suggested that way before the fix still carry it.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";

interface HealDB {
  core_scan_inbox_items: {
    status: string;
    target_location_id: string | null;
    suggested_location_id: string | null;
    suggested_location_note: string | null;
    suggested_candidates: unknown;
    updated_at: Date;
  };
}

const UNFOUNDED = sql<boolean>`status = 'pending'
  and target_location_id is null
  and suggested_location_id is not null
  and (coalesce(suggested_location_note, '') !~ '\\s[–—-]\\s\\S'
       or ((suggested_location_note ~ '\\s[–—-]\\swhere your other .+ are$'
            or suggested_location_note ~ '\\s[–—-]\\s[0-9]+ others are kept here$')
           and coalesce(suggested_candidates->0->>'instance', '') = ''))`;

/** Heal one workspace. Cheap when settled: one indexed update that matches
 *  nothing. */
export async function healUnfoundedPlaceSuggestionsIn(orgId: string, db: Kysely<HealDB>): Promise<number> {
  const res = await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_location_id: null, suggested_location_note: null, updated_at: new Date() })
    .where(UNFOUNDED)
    .executeTakeFirst();
  const n = Number(res.numUpdatedRows ?? 0);
  if (n) console.log(`[core-scan] org ${orgId}: withdrew ${n} suggested place(s) nothing about the item stood behind`);
  return n;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerUnfoundedPlaceSuggestionsHeal(): void {
  registerHealPass({
    name: "core-scan.heal-unfounded-place-suggestions",
    shim: "modules/core-scan/src/heal-unfounded-place-suggestions.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healUnfoundedPlaceSuggestionsIn(orgId, db as Kysely<HealDB>),
  });
}
