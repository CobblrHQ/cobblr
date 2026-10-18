// One-shot heal: give every pending photo row its picture's hash, so a pair
// of the same picture added before the hash existed is offered as one to keep
// (services/same-picture.ts, #3852).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row with an
// image_file_id and no suggested_metadata->>'image_sha256'. Check with, per
// tenant:
//   select count(*) from core_scan_inbox_items
//    where status = 'pending' and image_file_id is not null
//      and suggested_metadata->>'image_sha256' is null;
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call. Nothing
// re-creates the shape: every photo scan stamps its hash at intake.
//
// WHY IT EXISTS: a screenshot pasted twice, because nothing showed it had
// landed, left two identical items waiting in the inbox (#3852).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { pictureHash } from "./services/same-picture.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    image_file_id: string | null;
    suggested_metadata: unknown;
    created_at: Date;
  };
}

/** Heal one workspace, a page at a time. A picture that cannot be read is
 *  stamped empty so it is not read again. */
export async function healPictureHashesIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "image_file_id"])
    .where("created_at", "<", since)
    .where("status", "=", "pending")
    .where("image_file_id", "is not", null)
    .where(sql<boolean>`suggested_metadata->>'image_sha256' is null`)
    .limit(100)
    .execute();
  for (const r of rows) {
    const hash = (await pictureHash(orgId, r.image_file_id!).catch(() => null)) ?? "";
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ image_sha256: hash })}::jsonb` as never })
      .where("id", "=", r.id)
      .execute();
  }
  if (rows.length) console.log(`[core-scan] org ${orgId}: stamped the picture hash on ${rows.length} pending row(s)`);
  return rows.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts). */
export function registerPictureHashHeal(): void {
  registerHealPass({
    name: "core-scan.heal-picture-hashes",
    since: "2026-09-28T20:21:07Z",
    shim: "modules/core-scan/src/heal-picture-hashes.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healPictureHashesIn(orgId, db as Kysely<HealDB>, since),
  });
}
