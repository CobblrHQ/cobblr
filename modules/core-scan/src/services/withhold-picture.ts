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
import { catalogPictureContradicts, looksOfRow, statedColoursOf } from "./picture-agrees.js";
import { colourShows, looksDifferent, pictureColour, pictureColours, type ColourFamily, type ColourShares } from "./picture-colour.js";

interface WithholdDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    suggested_name: string | null;
    suggested_manufacturer: string | null;
    suggested_candidates: unknown;
    suggested_metadata: unknown;
    catalog_image_file_id: string | null;
    catalog_image_url: string | null;
    image_file_id: string | null;
    source_kind: string;
    barcode_text: string | null;
    updated_at: Date;
  };
}

/** The colours of the item's OWN photo, when the row was identified from it
 *  (a photo of the thing, not a frame of a barcode), measured once per file
 *  and kept on the row. Null for any other row: there is nothing of the
 *  item's own to compare a found picture with (#4037). */
export async function ownPhotoColours(orgId: string, db: Kysely<WithholdDB>, itemId: string): Promise<ColourShares | null> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["image_file_id", "source_kind", "barcode_text", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row?.image_file_id || row.source_kind !== "photo" || row.barcode_text) return null;
  const kept = ((row.suggested_metadata ?? {}) as { own_photo_colours?: { file_id?: string; shares?: ColourShares } }).own_photo_colours;
  if (kept?.file_id === row.image_file_id && kept.shares) return kept.shares;
  const file = await platform().files.read(orgId, row.image_file_id, "original").catch(() => null);
  const shares = file ? await pictureColours(new Uint8Array(file.bytes)) : null;
  if (!shares) return null;
  await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ own_photo_colours: { file_id: row.image_file_id, shares } })}::jsonb` as never })
    .where("id", "=", itemId)
    .execute();
  return shares;
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
  // Found for a row identified from its own photo: it has to look like that
  // photo too, not only carry a colour word the row states (#4037).
  const own = await ownPhotoColours(orgId, db, itemId);
  let unlike: string | null = null;
  if (own) {
    const file = await platform().files.read(orgId, row.catalog_image_file_id, "original").catch(() => null);
    unlike = looksDifferent(own, file ? await pictureColours(new Uint8Array(file.bytes)) : null);
  }
  const why = catalogPictureContradicts({ ...row, suggested_metadata: meta }) ?? unlike;
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

export type RechooseOutcome = "shows" | "sought" | "already sought" | "nothing";

/** Look for a picture that SHOWS the colour the row states, when its picture
 *  does not (#3729). A colour can arrive after the picture: the label read
 *  says "J7 DARK BLUE" for a row whose picture was chosen from the barcode
 *  alone, or a withheld picture left none. The search runs once per stated
 *  colour set (`catalog_colour_sought`), so a row whose web has no picture of
 *  that colour does not search on every photo read. A picture the person
 *  chose is never replaced. */
export async function rechoosePictureForColour(orgId: string, db: Kysely<WithholdDB>, itemId: string): Promise<RechooseOutcome> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_name", "suggested_manufacturer", "suggested_candidates", "suggested_metadata", "catalog_image_file_id", "catalog_image_url"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row?.suggested_name || row.status !== "pending") return "nothing";
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  if (meta.catalog_image_user_set) return "nothing";
  const stated = statedColoursOf(looksOfRow(row));
  if (stated.size === 0) return "nothing";
  const measured = meta.catalog_colour as { family?: ColourFamily | null; share?: number; file_id?: string } | undefined;
  if (
    row.catalog_image_file_id &&
    measured?.file_id === row.catalog_image_file_id &&
    measured.family &&
    colourShows(stated, { family: measured.family, share: measured.share ?? 0 })
  )
    return "shows";
  const key = [...stated].sort().join("/");
  if (meta.catalog_colour_sought === key) return "already sought";
  await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ catalog_colour_sought: key })}::jsonb` as never })
    .where("id", "=", itemId)
    .execute();
  // enrich-photo imports this module, so the search is reached lazily.
  const { refreshCatalogImageByName } = await import("./enrich-photo.js");
  await refreshCatalogImageByName(orgId, itemId, row.suggested_name, row.suggested_manufacturer);
  return "sought";
}
