// Taking back a picture while it is on its way in (#9271). The owner: "If I
// upload the wrong picture I want an X on the initial uploading/processing card."
// One implementation behind the card's X, the route and the assistant. Nothing a
// person kept is lost: a row that exists goes to Recently deleted, as a Discard
// does, and only a file nothing was made from is removed.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";

/** A code's picture can land on a row that was already waiting (the scan dedupes
 *  by barcode), and that row is older than this picture. It has counts of its
 *  own, and taking this picture back must not take those too. */
const JUST_MADE_MS = 15 * 60_000;

export const TAKEN_BACK_KEY = "taken_back_at";

export type TakeBackAnswer =
  | { outcome: "row"; item_id: string; name: string | null }
  | { outcome: "removed" }
  | { outcome: "joined"; item_id: string; name: string | null }
  | { outcome: "filed"; item_id: string; name: string | null }
  | { outcome: "nothing" };

export async function takeBackPicture(db: Kysely<CoreScanDB>, orgId: string, by: { fileId?: string | null; itemId?: string | null }): Promise<TakeBackAnswer> {
  const fileId = by.fileId ?? null;
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_name", "created_at", "image_file_id"])
    .$if(!!by.itemId, (q) => q.where("id", "=", by.itemId!))
    .$if(!by.itemId && !!fileId, (q) => q.where("image_file_id", "=", fileId!))
    .where("status", "!=", "discarded")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!row) {
    if (!fileId) return { outcome: "nothing" };
    await db.insertInto("core_scan_pictures_taken_back").values({ file_id: fileId }).onConflict((oc) => oc.doNothing()).execute();
    await platform().files.removeForGood(orgId, fileId);
    return { outcome: "removed" };
  }
  const name = row.suggested_name ?? null;
  if (row.status === "resolved") return { outcome: "filed", item_id: row.id, name };
  if (!by.itemId && Date.now() - new Date(row.created_at).getTime() > JUST_MADE_MS) return { outcome: "joined", item_id: row.id, name };
  await db
    .updateTable("core_scan_inbox_items")
    .set({ status: "discarded", suggested_metadata: mergeMeta({ [TAKEN_BACK_KEY]: new Date().toISOString() }) as never, updated_at: new Date() })
    .where("id", "=", row.id)
    .where("status", "!=", "resolved")
    .execute();
  return { outcome: "row", item_id: row.id, name };
}

/** A scan on its way for a picture already taken back is refused. */
export async function pictureWasTakenBack(db: Kysely<CoreScanDB>, fileId: string): Promise<boolean> {
  return !!(await db.selectFrom("core_scan_pictures_taken_back").select("file_id").where("file_id", "=", fileId).executeTakeFirst());
}

/** The row a read is for was taken back while it read. */
export async function rowWasTakenBack(db: Kysely<CoreScanDB>, itemId: string): Promise<boolean> {
  const row = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", itemId).executeTakeFirst();
  return !!row && TAKEN_BACK_KEY in ((row.suggested_metadata ?? {}) as object);
}
