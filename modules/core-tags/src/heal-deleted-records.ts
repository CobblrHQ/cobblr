import { forgetLegacyDeletedTag } from "./tag-writes.js";
// DONE WHEN: core_tags_deleted is empty in every workspace.
// BORN WITH: tag-writes keeps every new deletion in platform.deletedRecords.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreTagsDB } from "./db.js";

export function registerDeletedTagsHeal(): void {
  registerHealPass({ name: "core-tags.deleted-records", since: "2026-10-04T02:41:07Z", shim: "modules/core-tags/src/heal-deleted-records.ts", module: "core-tags", visit: async ({ orgId, db, since }) => {
    const own = db as Kysely<CoreTagsDB>;
    const rows = await own.selectFrom("core_tags_deleted").selectAll().where("deleted_at", "<", since).execute();
    for (const kept of rows) {
      const row = (typeof kept.row === "string" ? JSON.parse(kept.row) : kept.row) as Record<string, unknown>;
      if (!await platform().deletedRecords.get(orgId, "core-tags:tag", kept.id)) await platform().deletedRecords.keep(orgId, "core-tags:tag", kept.id, row, kept, kept.deleted_by, new Date(kept.deleted_at));
      await forgetLegacyDeletedTag(own, kept.id);
    }
    return rows.length;
  } });
}
