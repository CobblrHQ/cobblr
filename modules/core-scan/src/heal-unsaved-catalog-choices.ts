// One-shot heal: a catalog choice that is only an address is stored now, or
// let go with "Couldn't save this one" (services/catalog-store.ts, #4580).
//
// DONE WHEN: no tenant DB has a pending or enriching core_scan_inbox_items row
// with catalog_image_url set and catalog_image_file_id null, and no
// core_scan_record_photo_suggestions row with status 'suggested', no file_id
// and no held picture. Check with, per tenant:
//   select count(*) from core_scan_inbox_items
//    where status in ('pending','enriching')
//      and catalog_image_url is not null and catalog_image_file_id is null;
//   select count(*) from core_scan_record_photo_suggestions
//    where status = 'suggested' and file_id is null and held_bytes is null;
// /healthz reports the count this pass found (noteHealShim). When both read 0
// on prod, staging and dev, delete this file and its boot call.
//
// BORN WITH: nothing (a new choice is stored before it is committed: the
// catalog-image door and downloadCatalogImage never leave an address alone,
// and a suggestion is offered only with its picture: held in the suggestion
// store since #7447, a file before).
//
// WHY IT EXISTS: rows chosen before that rule held an address the browser
// could draw and the server never stored, so the card showed the picture in
// its CATALOG panel and the person's scan as its thumbnail.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { storeOrClearCatalogUrl } from "./services/catalog-store.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    catalog_image_url: string | null;
    catalog_image_file_id: string | null;
    created_at: Date;
  };
  core_scan_record_photo_suggestions: {
    entity_kind: string;
    entity_id: string;
    status: string;
    file_id: string | null;
    held_bytes: Buffer | null;
    attempts: number;
    updated_at: Date;
  };
}

/** Heal one workspace. Cheap on the happy path: two indexed counts. */
export async function healUnsavedCatalogChoicesIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "catalog_image_url"])
    .where("created_at", "<", since)
    .where("status", "in", ["pending", "enriching"])
    .where("catalog_image_url", "is not", null)
    .where("catalog_image_file_id", "is", null)
    .limit(50)
    .execute();
  let stored = 0;
  let cleared = 0;
  for (const r of rows) {
    try {
      const done = await storeOrClearCatalogUrl({ db: db as never, orgId, itemId: r.id }, r.catalog_image_url!);
      if (done === "stored") stored++;
      else cleared++;
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-unsaved-catalog-choices", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not store its catalog picture:`, (err as Error).message);
    }
  }
  // A suggestion offered with no picture at all is looked for again. One that
  // holds its picture (#7447: a suggestion is not a file) is whole.
  const requeued = await db
    .updateTable("core_scan_record_photo_suggestions")
    .set({ status: "queued", attempts: 0, updated_at: new Date() })
    .where("status", "=", "suggested")
    .where("file_id", "is", null)
    .where("held_bytes", "is", null)
    .executeTakeFirst()
    .then((r) => Number(r.numUpdatedRows ?? 0))
    .catch(() => 0);
  if (stored || cleared || requeued) {
    console.log(`[core-scan] org ${orgId}: catalog addresses stored ${stored}, let go ${cleared}; suggestions looked for again ${requeued}`);
  }
  return rows.length + requeued;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerUnsavedCatalogChoicesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-unsaved-catalog-choices",
    since: "2026-10-03T03:44:25Z",
    shim: "modules/core-scan/src/heal-unsaved-catalog-choices.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healUnsavedCatalogChoicesIn(orgId, db as Kysely<HealDB>, since),
  });
}
