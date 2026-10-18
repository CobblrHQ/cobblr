// One-shot heal: a pending row whose catalog picture is a stock agency's
// watermarked preview has it set aside and is given the next picture (#3804).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row, not
// picked by a person, whose catalog_image_url or
// suggested_metadata->>'catalog_image_from' is on a host in
// services/stock-picture-sources.ts. Check with, per tenant:
//   select count(*) from core_scan_inbox_items
//    where status = 'pending'
//      and coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false
//      and (catalog_image_url ~* '(alamy|shutterstock|gettyimages|istockphoto|dreamstime|depositphotos|123rf|ftcdn)'
//        or suggested_metadata->>'catalog_image_from' ~* '(alamy|shutterstock|gettyimages|istockphoto|dreamstime|depositphotos|123rf|ftcdn)');
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call. Nothing
// re-creates the shape: the picture ladder, the download and the fetch all
// refuse a stock preview now.
//
// WHY IT EXISTS: a grocery item came home with an agency's preview, its
// watermark printed across it, because nothing refused one (#3804).
//
// What it can find: a row that carries the picture's address. A picture
// stored before the address was recorded (catalog_image_from) keeps none,
// so it cannot be told apart from any other and is left as it is.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { isStockPreviewUrl } from "./services/stock-preview.js";
import { STOCK_AGENCY_HOSTS, STOCK_PREVIEW_FILENAME_MARKERS } from "./services/stock-picture-sources.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    suggested_name: string | null;
    suggested_manufacturer: string | null;
    catalog_image_file_id: string | null;
    catalog_image_url: string | null;
    suggested_metadata: unknown;
    updated_at: Date;
    created_at: Date;
  };
}

/** Why the picture went, on the row it went from. */
export const STOCK_PREVIEW_WHY = "a stock agency's watermarked preview, never an item's picture";

/** A cheap SQL prefilter from the same lists the code reads; the rows it
 *  returns are judged again with isStockPreviewUrl. */
export function stockPrefilterPattern(): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(${[...STOCK_AGENCY_HOSTS, ...STOCK_PREVIEW_FILENAME_MARKERS].map(esc).join("|")})`;
}

type Repick = (orgId: string, itemId: string, name: string, brand: string | null) => Promise<unknown>;

/** Heal one workspace: set aside every stock-preview picture on a pending row
 *  nobody picked, then look for the next picture. Answers how many rows it
 *  found. `repick` is injectable so the heal is testable without a search. */
export async function healStockPicturesIn(orgId: string, db: Kysely<HealDB>, since: Date, repick?: Repick): Promise<number> {
  const pattern = stockPrefilterPattern();
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_manufacturer", "catalog_image_file_id", "catalog_image_url", "suggested_metadata"])
    .where("created_at", "<", since)
    .where("status", "=", "pending")
    .where(sql<boolean>`coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false`)
    .where(sql<boolean>`(catalog_image_url ~* ${pattern} or suggested_metadata->>'catalog_image_from' ~* ${pattern})`)
    .limit(50)
    .execute();
  let healed = 0;
  for (const r of rows) {
    const from = (r.suggested_metadata as { catalog_image_from?: string } | null)?.catalog_image_from ?? null;
    if (!isStockPreviewUrl(r.catalog_image_url) && !isStockPreviewUrl(from)) continue;
    try {
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: null,
          catalog_image_url: null,
          suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_image_from' - 'catalog_colour') || ${JSON.stringify({
            catalog_image_withheld: { file_id: r.catalog_image_file_id, url: from ?? r.catalog_image_url, why: STOCK_PREVIEW_WHY, at: new Date().toISOString() },
          })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", r.id)
        .where(sql<boolean>`coalesce((suggested_metadata->>'catalog_image_user_set')::boolean, false) = false`)
        .execute();
      healed++;
      if (r.suggested_name) {
        const pick: Repick =
          repick ??
          (async (o, i, n, b) => {
            const { refreshCatalogImageByName } = await import("./services/enrich-photo.js");
            return refreshCatalogImageByName(o, i, n, b);
          });
        await pick(orgId, r.id, r.suggested_name, r.suggested_manufacturer);
      }
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-stock-pictures", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not replace its stock-preview picture:`, (err as Error).message);
    }
  }
  if (healed > 0) console.log(`[core-scan] org ${orgId}: set aside ${healed} stock-preview picture(s) and looked for the next`);
  return rows.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts). */
export function registerStockPictureHeal(): void {
  registerHealPass({
    name: "core-scan.heal-stock-pictures",
    since: "2026-09-28T14:29:44Z",
    shim: "modules/core-scan/src/heal-stock-pictures.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healStockPicturesIn(orgId, db as Kysely<HealDB>, since),
  });
}
