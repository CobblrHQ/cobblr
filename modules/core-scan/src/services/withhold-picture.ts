// A catalog picture that shows another colour than the item states is set
// aside, never shown as the item's picture (#3729).
//
// The item's colour can arrive after its picture: a web search names a yarn
// and picks a picture, then the label read says "J7 DARK BLUE". So the check
// runs whenever what the row says about itself changes, not only when a
// picture is downloaded, and once over rows that already hold a picture
// (heal-picture-colour.ts). The picture is set aside, not deleted: it stays
// on the row under catalog_image_withheld, so it can be brought back, and
// the person's own photo is the row's picture meanwhile.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { catalogPictureContradicts } from "./picture-agrees.js";
import { pictureColour } from "./picture-colour.js";

interface WithholdDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    suggested_name: string | null;
    suggested_candidates: unknown;
    suggested_metadata: unknown;
    catalog_image_file_id: string | null;
    catalog_image_url: string | null;
    updated_at: Date;
  };
}

export type WithholdOutcome = "withheld" | "kept" | "measured" | "nothing";

/** Measure the row's catalog picture when it has not been, then set it aside
 *  when it contradicts what the row says it looks like. A picture the person
 *  chose is never touched. */
export async function withholdContradictedPicture(orgId: string, db: Kysely<WithholdDB>, itemId: string): Promise<WithholdOutcome> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_name", "suggested_candidates", "suggested_metadata", "catalog_image_file_id", "catalog_image_url"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row?.catalog_image_file_id || row.status !== "pending") return "nothing";
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  if (meta.catalog_image_user_set) return "kept";
  let measured = false;
  const stamp = meta.catalog_colour as { file_id?: string } | undefined;
  if (stamp?.file_id !== row.catalog_image_file_id) {
    const file = await platform().files.read(orgId, row.catalog_image_file_id, "original").catch(() => null);
    const colour = file ? await pictureColour(new Uint8Array(file.bytes)) : null;
    // Stamped even when unreadable, so the heal does not ask again.
    meta.catalog_colour = { ...(colour ?? { family: null, share: 0 }), file_id: row.catalog_image_file_id };
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ catalog_colour: meta.catalog_colour })}::jsonb` as never })
      .where("id", "=", itemId)
      .execute();
    measured = true;
  }
  const why = catalogPictureContradicts({ ...row, suggested_metadata: meta });
  if (!why) return measured ? "measured" : "kept";
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      catalog_image_file_id: null,
      catalog_image_url: null,
      suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_colour') || ${JSON.stringify({
        catalog_image_withheld: { file_id: row.catalog_image_file_id, url: row.catalog_image_url, why, at: new Date().toISOString() },
      })}::jsonb` as never,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    // Only the picture that was judged: never one a person set meanwhile.
    .where("catalog_image_file_id", "=", row.catalog_image_file_id)
    .where(sql<boolean>`coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false`)
    .execute();
  console.log(`[core-scan] org ${orgId} row ${itemId}: set its catalog picture aside (${why})`);
  return "withheld";
}
