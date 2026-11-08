// One-shot heal: a receipt line below the confidence floor gives back the picture
// that was searched for its guessed name (#9270).
//
// DONE WHEN: /healthz reads 0 for this shim on prod, canary, staging and app. It
// records the count itself through registerHealPass (noteHealShim). Nothing
// re-creates the shape: the match no longer searches a picture below the floor
// (pictureAfterMatchAllowed), and neither does its retry, the pictures sweep
// (nameIsAGuess), which until then put the picture back within twenty minutes.
// Delete this file and its boot call then.
//
// WHY IT EXISTS: "Assorted Thin", a grocer's line sold by weight, was shown with
// a photo of sewing needles at 30%, and filing would have put it on the record. A
// picture a person chose stays, and so does one the order printed. The picture
// is kept on the row as withheld, not deleted, as the stock-picture heal does.
//
// BORN WITH: a fresh workspace has no rows, and every line it reads goes through
// pictureAfterMatchAllowed.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { SCAN_REVIEW_CONFIDENCE } from "@cobblr/platform-contract/scan-triage";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    source_kind: string | null;
    ai_confidence: string | number | null;
    catalog_image_file_id: string | null;
    catalog_image_url: string | null;
    suggested_metadata: unknown;
    updated_at: Date;
    created_at: Date;
  };
}

export const GUESSED_PICTURE_WHY = "searched for a name nobody was sure of";

/** Heal one workspace. Every row it finds it settles, so a second visit finds none. */
export async function healGuessedReceiptPicturesIn(db: Kysely<HealDB>, since: Date): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "catalog_image_file_id", "catalog_image_url", "suggested_metadata"])
    .where("created_at", "<", since)
    .where("status", "=", "pending")
    .where("source_kind", "=", "receipt")
    .where(sql<boolean>`ai_confidence::numeric < ${SCAN_REVIEW_CONFIDENCE}`)
    .where(sql<boolean>`(catalog_image_file_id is not null or catalog_image_url is not null)`)
    .where(sql<boolean>`coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false`)
    .where(sql<boolean>`not (coalesce(suggested_metadata, '{}'::jsonb) ? 'order_line_image')`)
    .limit(200)
    .execute();
  for (const r of rows) {
    const from = (r.suggested_metadata as { catalog_image_from?: string } | null)?.catalog_image_from ?? null;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        catalog_image_file_id: null,
        catalog_image_url: null,
        suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_image_from' - 'catalog_colour') || ${JSON.stringify({
          catalog_image_withheld: { file_id: r.catalog_image_file_id, url: from ?? r.catalog_image_url, why: GUESSED_PICTURE_WHY, at: new Date().toISOString() },
        })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      .where(sql<boolean>`coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false`)
      .execute();
  }
  if (rows.length > 0) console.log(`[core-scan] heal-guessed-receipt-pictures: withheld ${rows.length} picture(s)`);
  return rows.length;
}

/** Call from onBoot. */
export function registerGuessedReceiptPicturesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-guessed-receipt-pictures",
    since: "2026-11-07T00:00:00Z",
    shim: "modules/core-scan/src/heal-guessed-receipt-pictures.ts",
    module: "core-scan",
    visit: ({ db, since }) => healGuessedReceiptPicturesIn(db as Kysely<HealDB>, since),
  });
}
