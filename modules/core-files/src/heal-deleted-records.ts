// DONE WHEN: every recently deleted core_files_files row has a platform.deletedRecords entry.
// BORN WITH: HTTP deletion captures every new file deletion in the platform store.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreFilesDB } from "./db.js";

export function registerDeletedFilesHeal(): void {
  registerHealPass({ name: "core-files.deleted-records", since: "2026-10-04T02:41:07Z", shim: "modules/core-files/src/heal-deleted-records.ts", module: "core-files", visit: async ({ orgId, db, since }) => {
    const rows = await (db as Kysely<CoreFilesDB>).selectFrom("core_files_files").selectAll()
      .where("deleted_at", ">", new Date(Date.now() - 30 * 86_400_000)).where("deleted_at", "<", since).where("same_as", "is", null).execute();
    let added = 0;
    for (const row of rows) {
      if (await platform().deletedRecords.get(orgId, "core-files:file", row.id)) continue;
      await platform().deletedRecords.keep(orgId, "core-files:file", row.id, { ...row, deleted_at: null }, undefined, null, new Date(row.deleted_at!));
      added++;
    }
    return added;
  } });
}
