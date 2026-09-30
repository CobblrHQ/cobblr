// Folders for module code (platform().files.ensureFolder / fileInto): a
// module that keeps a set of files together makes a place for them the way a
// person would, by name under a path, in the same folders the Files page
// shows and a person can rearrange.
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreFilesDB } from "../db.js";

async function ensureOne(db: Kysely<CoreFilesDB>, parentId: string | null, name: string): Promise<string> {
  const clean = name.trim().slice(0, 120) || "Untitled";
  const find = () =>
    db
      .selectFrom("core_files_folders")
      .select("id")
      .where(sql<boolean>`lower(btrim(name)) = lower(btrim(${clean}))`)
      .where((eb) => (parentId ? eb("parent_id", "=", parentId) : eb("parent_id", "is", null)))
      .executeTakeFirst();
  const hit = await find();
  if (hit) return hit.id;
  // Two callers making the same folder at once: one insert wins the unique
  // name index and the other reads the winner.
  const made = await db
    .insertInto("core_files_folders")
    .values({ name: clean, parent_id: parentId })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (made) return made.id;
  const again = await find();
  if (!again) throw new Error(`folder "${clean}" could not be made`);
  return again.id;
}

export function registerFolders(): void {
  platform().files.registerFolders({
    async ensure(orgId, path) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
      let parent: string | null = null;
      for (const name of path) parent = await ensureOne(db, parent, name);
      if (!parent) throw new Error("a folder path needs at least one name");
      return parent;
    },
    async file(orgId, fileId, folderId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
      const r = await db
        .updateTable("core_files_files")
        .set({ folder_id: folderId })
        .where("id", "=", fileId)
        .where("folder_id", "is", null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },
  });
}
