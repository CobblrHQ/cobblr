import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreFilesDB } from "./db.js";

export function registerDeletedAttachments(): void {
  const dbOf = async (orgId: string) => await platform().tenants.getDb(orgId) as Kysely<CoreFilesDB>;
  platform().deletedRecords.registerParticipant("core-files.attachments", {
    snapshot: async (orgId, ref, snapshot) => {
      const children = snapshot?.related as { rows?: Array<{ row: { id?: string } }> } | undefined;
      const ids = [ref.id, ...(children?.rows ?? []).flatMap((r) => r.row.id ? [r.row.id] : [])];
      const pairs = [...new Set([ref.kind, await platform().entities.baseKindOf(orgId, ref.kind)])].map((k) => k.split(":"));
      return (await dbOf(orgId)).selectFrom("core_files_attachments").selectAll().where("source_id", "in", ids)
        .where((eb) => eb.or(pairs.map(([module]) => eb("source_module", "=", module!)))).execute();
    },
    purge: async (orgId, _ref, image) => {
      const db = await dbOf(orgId);
      for (const row of image as Array<{ id: string; file_id: string; source_id: string }>) {
        await db.deleteFrom("core_files_attachments").where("id", "=", row.id).where("file_id", "=", row.file_id).where("source_id", "=", row.source_id).execute();
      }
    },
    restore: async (orgId, _ref, image) => {
      const db = await dbOf(orgId);
      for (const row of image as Array<{ id: string; file_id: string; source_module: string; source_type: string; source_id: string; role: string | null; sort_order: number; created_at: string }>) {
        if (!await db.selectFrom("core_files_files").select("id").where("id", "=", row.file_id).executeTakeFirst()) continue;
        await db.insertInto("core_files_attachments").values({ ...row, created_at: new Date(row.created_at) }).onConflict((oc) => oc.doNothing()).execute();
      }
    },
  });
}
