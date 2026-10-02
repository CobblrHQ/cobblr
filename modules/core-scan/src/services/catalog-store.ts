// A catalog choice is the stored file or nothing (#4580).
//
// A row that remembered its catalog picture only as an address showed it in
// one place (the CATALOG panel, drawn from the site in the browser) and not in
// the other (the thumbnail, drawn from the stored copy that never existed):
// "how do I have it in the one place but not the other?" An address is
// stored now if the site still gives it, else let go, with the reason on the
// row so the card can say "Couldn't save this one" and offer another.

import { mergeMeta } from "./metadata.js";
import { downloadCatalogImage } from "./enrich.js";

import { CATALOG_UNSAVED_KEY as UNSAVED_KEY, COULDNT_SAVE_WORDS } from "@cobblr/platform-contract/scan-pictures";

type Db = Parameters<typeof downloadCatalogImage>[0]["db"];

/** Store the address as the row's catalog picture, or clear it and say so.
 *  Only clears while the row still holds that address and no stored file, so
 *  a picture chosen meanwhile is never touched. */
export async function storeOrClearCatalogUrl(ctx: { db: Db; orgId: string; itemId: string }, url: string): Promise<"stored" | "cleared"> {
  if (await downloadCatalogImage(ctx, url).catch(() => false)) return "stored";
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      catalog_image_url: null,
      suggested_metadata: mergeMeta({ [UNSAVED_KEY]: { url, why: COULDNT_SAVE_WORDS, at: new Date().toISOString() } }) as never,
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .where("catalog_image_url", "=", url)
    .where("catalog_image_file_id", "is", null)
    .execute();
  return "cleared";
}
