// Recently deleted, and gone for good after it.
//
// Deleting a file used to set deleted_at and nothing else: nothing could bring
// it back, and nothing ever removed its bytes, so a photo a person deleted
// stayed on disk for the life of the workspace, outside the quota (#4115).
// Now a deleted file sits in Recently deleted for RECENTLY_DELETED_DAYS, where
// it can be restored or deleted forever at once, and then this sweep removes
// its bytes and its row (its attachments go with the row, on delete cascade).
//
// PERMANENT: the sweep is how deletion finishes, not a heal.
// BORN WITH: nothing (a workspace has no deleted files until someone deletes
// one, and the first round after that finds it).
//
// Every row keeps its own bytes (a same-bytes copy serves its own copy), so
// removing one row's directory never touches another's. A deleted file that a
// live copy still names in `same_as` waits: the copy stays resolvable by its
// id and the pointer is what ties it to what it repeats.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreFilesDB } from "./db.js";
import { removeStoredFile } from "./api/storage.js";
import { bytesUsed, QUOTA_BYTES, quotaDecision } from "./api/quota.js";

export const RECENTLY_DELETED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const PURGE_PASS = "core-files.purge-deleted";
/** Files purged per workspace per round; a round with more goes again soon. */
const PER_ROUND = 200;

/** When a file deleted at `deletedAt` is purged. */
export function purgeAfter(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RECENTLY_DELETED_DAYS * DAY_MS);
}

/** Remove a deleted file's bytes and row, unless a live copy still points at
 *  it. Returns whether it went. Never touches a live file. */
export async function purgeFile(db: Kysely<CoreFilesDB>, orgId: string, fileId: string): Promise<boolean> {
  return platform().deletedRecords.exclusive(orgId, "core-files:file", fileId, () => purgeFileLocked(db, orgId, fileId));
}

async function purgeFileLocked(db: Kysely<CoreFilesDB>, orgId: string, fileId: string): Promise<boolean> {
  const row = await db
    .selectFrom("core_files_files")
    .select(["id", "deleted_at"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (!row || row.deleted_at === null) return false;
  const pointedAt = await db
    .selectFrom("core_files_files")
    .select("id")
    .where("same_as", "=", fileId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (pointedAt) return false;
  await removeStoredFile(orgId, fileId);
  await db.deleteFrom("core_files_files").where("id", "=", fileId).where("deleted_at", "is not", null).execute();
  await platform().deletedRecords.forget(orgId, "core-files:file", fileId);
  return true;
}

/** Purge every file whose Recently deleted days have run out by `now`. */
export async function purgeDue(
  db: Kysely<CoreFilesDB>,
  orgId: string,
  now: Date,
): Promise<{ purged: number; backlog: boolean }> {
  const cutoff = new Date(now.getTime() - RECENTLY_DELETED_DAYS * DAY_MS);
  const due = await db
    .selectFrom("core_files_files as f")
    .select("f.id")
    .where("f.deleted_at", "is not", null)
    .where("f.deleted_at", "<=", cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("core_files_files as c")
            .select(sql`1`.as("one"))
            .whereRef("c.same_as", "=", "f.id")
            .where("c.deleted_at", "is", null),
        ),
      ),
    )
    .orderBy("f.deleted_at")
    .limit(PER_ROUND + 1)
    .execute();
  let purged = 0;
  for (const r of due.slice(0, PER_ROUND)) {
    if (await purgeFile(db, orgId, r.id)) purged++;
  }
  return { purged, backlog: due.length > PER_ROUND };
}

export type RestoreResult = { ok: true } | { ok: false; code: "not_found" | "quota_exceeded"; message: string };

/** Bring a deleted file back where it was. It counts against the quota again,
 *  so a restore that would not fit is refused the way an upload is. */
export async function restoreFile(db: Kysely<CoreFilesDB>, orgId: string, fileId: string): Promise<RestoreResult> {
  return platform().deletedRecords.exclusive(orgId, "core-files:file", fileId, () => restoreFileLocked(db, orgId, fileId));
}

async function restoreFileLocked(db: Kysely<CoreFilesDB>, orgId: string, fileId: string): Promise<RestoreResult> {
  const row = await db
    .selectFrom("core_files_files")
    .select(["id", "size_bytes"])
    .where("id", "=", fileId)
    .where("deleted_at", ">", new Date(Date.now() - RECENTLY_DELETED_DAYS * DAY_MS))
    .executeTakeFirst();
  if (!row) return { ok: false, code: "not_found", message: "That file is not in Recently deleted." };
  const fits = quotaDecision(await bytesUsed(db), Number(row.size_bytes), QUOTA_BYTES);
  if (!fits.allow) return { ok: false, code: "quota_exceeded", message: fits.reason ?? "That would not fit." };
  await db.updateTable("core_files_files").set({ deleted_at: null }).where("id", "=", fileId).execute();
  await platform().events.emit("core-files.file.restored", { orgId, fileId });
  await platform().deletedRecords.forget(orgId, "core-files:file", fileId);
  return { ok: true };
}

/** Cobb's door to Recently deleted: restore a file by id. */
export function registerRestoreAction(): void {
  platform().actions.registerHandler("core-files.restore", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const fileId = typeof a.file_id === "string" && a.file_id ? a.file_id : ctx.entity?.kind === "core-files:file" ? ctx.entity.id : null;
    if (!fileId) return { ok: false, error: "which file to restore is needed (file_id)" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreFilesDB>;
    const r = await restoreFile(db, ctx.orgId, fileId);
    return r.ok ? { ok: true, file_id: fileId } : { ok: false, error: r.message, code: r.code };
  });
}

export function registerPurgeSweep(): void {
  platform().sweeps.register({
    name: PURGE_PASS,
    everyMs: 6 * 60 * 60 * 1000,
    drainMs: 60 * 1000,
    module: "core-files",
    visit: async ({ orgId, db, now }) => {
      const { purged, backlog } = await purgeDue(db as Kysely<CoreFilesDB>, orgId, now);
      if (purged) console.log(`[core-files] org ${orgId}: purged ${purged} deleted file(s)`);
      return { backlog };
    },
  });
}
