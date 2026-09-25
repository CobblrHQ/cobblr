// One-shot heal: measure the catalog picture of every pending row that
// holds one, and set aside a picture that shows another colour than the row
// states (services/withhold-picture.ts).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row with a
// catalog_image_file_id and no suggested_metadata->'catalog_colour' for that
// file. Check with, per tenant:
//   select count(*) from core_scan_inbox_items
//    where status = 'pending' and catalog_image_file_id is not null
//      and coalesce(suggested_metadata->'catalog_colour'->>'file_id', '') <> catalog_image_file_id::text;
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call. Nothing
// re-creates the shape: every download measures the picture it stores.
//
// WHY IT EXISTS: a web search gave a dark-blue yarn a beige skein's picture,
// and its label read said J7 DARK BLUE afterwards (#3729). Pictures stored
// before downloads were measured were never judged by what they show.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { withholdContradictedPicture } from "./services/withhold-picture.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    catalog_image_file_id: string | null;
    suggested_metadata: unknown;
  };
}

/** Heal one workspace. Cheap on the happy path: only unmeasured rows are read. */
export async function healPictureColourIn(orgId: string, db: Kysely<HealDB>): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id"])
    .where("status", "=", "pending")
    .where("catalog_image_file_id", "is not", null)
    .where(sql<boolean>`coalesce(suggested_metadata->'catalog_colour'->>'file_id', '') <> catalog_image_file_id::text`)
    .limit(200)
    .execute();
  let withheld = 0;
  for (const r of rows) {
    try {
      if ((await withholdContradictedPicture(orgId, db as never, r.id)) === "withheld") withheld++;
    } catch (err) {
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not measure its picture:`, (err as Error).message);
    }
  }
  if (withheld > 0) console.log(`[core-scan] org ${orgId}: set aside ${withheld} catalog picture(s) that contradict their item`);
  // A page of 200 per round; a measured row is not found again, so the next
  // round takes the rest.
  return rows.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerPictureColourHeal(): void {
  registerHealPass({
    name: "core-scan.heal-picture-colour",
    shim: "modules/core-scan/src/heal-picture-colour.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healPictureColourIn(orgId, db as Kysely<HealDB>),
  });
}
