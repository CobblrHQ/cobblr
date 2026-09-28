// The same picture pasted twice is one item (#3852).
//
// A screenshot pasted into the inbox gave no sign it had landed, so it was
// pasted again, and the inbox held two identical items, both "Awaiting
// lookup…". The picture's own bytes say whether it is the same one: the
// name of a clipboard image is always "image.png" and says nothing. The
// hash rides on the row (`image_sha256`), so a repeat within the window is
// answered as "already added", and a pair already in the inbox can be
// offered as one to keep (web/src/pages/scanTwins.tsx).

import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";

/** How long a repeat counts as the same paste rather than a second copy. */
export const SAME_PICTURE_WINDOW_MS = 10 * 60_000;

/** The picture's content hash, from the stored original. Null when the file
 *  cannot be read: then nothing is guarded, never a wrong refusal. */
export async function pictureHash(orgId: string, fileId: string): Promise<string | null> {
  const file = await platform().files.read(orgId, fileId, "original").catch(() => null);
  if (!file?.bytes?.length) return null;
  return createHash("sha256").update(file.bytes).digest("hex");
}

/** A pending row with the same picture, added within the window. */
export async function recentTwin(
  db: Kysely<CoreScanDB>,
  hash: string,
  now: Date = new Date(),
): Promise<{ id: string } | null> {
  const since = new Date(now.getTime() - SAME_PICTURE_WINDOW_MS);
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id"])
    .where("status", "=", "pending")
    .where("created_at", ">=", since)
    .where(sql<boolean>`suggested_metadata->>'image_sha256' = ${hash}`)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row ?? null;
}
