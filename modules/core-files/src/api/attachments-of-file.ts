// Where one file is attached: the reverse of the attachment lister.
//
// A table that makes one record per dropped file (the instance file intake)
// asks this before it makes one, so importing the same PDF twice, or a zip
// that holds a pattern already imported, links to the record that owns it
// instead of making a second. Live attachments of a live file only.
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreFilesDB } from "../db.js";

export function registerAttachmentsOfFile(): void {
  platform().files.registerAttachmentsOfFile(async (orgId, fileId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const rows = await db
      .selectFrom("core_files_attachments as fa")
      .innerJoin("core_files_files as f", "f.id", "fa.file_id")
      .select(["fa.id as id", "fa.source_module", "fa.source_type", "fa.source_id", "fa.role"])
      .where("fa.file_id", "=", fileId)
      .where("f.deleted_at", "is", null)
      .orderBy("fa.created_at", "asc")
      .execute();
    return rows.map((r) => ({
      attachmentId: r.id,
      source_module: r.source_module,
      source_type: r.source_type,
      source_id: r.source_id,
      role: r.role,
    }));
  });
}
