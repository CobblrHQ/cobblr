// One-shot heal: fold server-written copies of a file into the file they
// repeat byte for byte (#3859).
//
// DONE WHEN: no tenant DB has two live core_files_files rows with the same
// (sha256, size_bytes) where a copy that is not the oldest has
// owner_user_id null and same_as null. Check with, per tenant:
//   select sha256, size_bytes, count(*) from core_files_files
//    where deleted_at is null and same_as is null
//    group by 1, 2 having count(*) > 1;
// and read owner_user_id on the rows it names: only rows a person uploaded
// themselves may remain. When that holds on prod, staging and dev, delete this
// file and its boot call. The writer (resolvers.ts registerWriter) returns the
// file already holding the bytes now, so nothing makes new copies.
//
// WHY IT EXISTS: the server-side writer stored the same picture again every
// time a path fetched it twice, so a workspace's search listed one catalog
// photo two and three times. The writer no longer does; this folds what it
// already did. A copy is not deleted: other modules hold file ids directly (a
// scan's catalog picture, a record's image path), and core-files may not
// rewrite their columns, so the copy stays resolvable by its id and serves its
// own (identical) bytes. It gains `same_as` (left out of every list), and its
// attachments move to the file it repeats. A person's own second upload is
// left alone: the upload route asks before keeping one, so it was a choice.

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { CoreFilesDB } from "./db.js";

export interface FileRowForFold {
  id: string;
  sha256: string;
  size_bytes: string;
  owner_user_id: string | null;
  created_at: Date;
  same_as: string | null;
}

/** Which copies fold into which file: within each set of identical bytes the
 *  oldest file is the one kept, and every OTHER server-written file not yet
 *  folded is a copy of it. Pure, so the rule is held by a test. */
export function planSameBytesFolds(rows: readonly FileRowForFold[]): Array<{ copy: string; keep: string }> {
  const groups = new Map<string, FileRowForFold[]>();
  for (const r of rows) {
    const key = `${r.sha256}:${r.size_bytes}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: Array<{ copy: string; keep: string }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const byAge = [...group].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    const keep = byAge[0]!;
    for (const r of byAge.slice(1)) {
      if (r.owner_user_id === null && r.same_as === null) out.push({ copy: r.id, keep: keep.id });
    }
  }
  return out;
}

/** Heal one workspace; answers how many copies it folded. */
export async function healSameBytesIn(orgId: string, db: Kysely<CoreFilesDB>): Promise<number> {
  // The happy path: one grouped query over the index, no rows read.
  const dupes = await db
    .selectFrom("core_files_files")
    .select(["sha256", "size_bytes"])
    .where("deleted_at", "is", null)
    .where("same_as", "is", null)
    .groupBy(["sha256", "size_bytes"])
    .having((eb) => eb.fn.countAll(), ">", 1)
    .execute();
  if (dupes.length === 0) return 0;
  let folded = 0;
  for (const d of dupes) {
    const rows = await db
      .selectFrom("core_files_files")
      .select(["id", "sha256", "size_bytes", "owner_user_id", "created_at", "same_as"])
      .where("sha256", "=", d.sha256)
      .where("size_bytes", "=", d.size_bytes)
      .where("deleted_at", "is", null)
      .execute();
    for (const { copy, keep } of planSameBytesFolds(rows)) {
      await db.transaction().execute(async (tx) => {
        // Its attachments move to the file it repeats; one the kept file
        // already has (same record, same role) is dropped rather than doubled.
        const moving = await tx.selectFrom("core_files_attachments").selectAll().where("file_id", "=", copy).execute();
        for (const a of moving) {
          const already = await tx
            .selectFrom("core_files_attachments")
            .select("id")
            .where("file_id", "=", keep)
            .where("source_module", "=", a.source_module)
            .where("source_type", "=", a.source_type)
            .where("source_id", "=", a.source_id)
            .where((eb) => (a.role === null ? eb("role", "is", null) : eb("role", "=", a.role)))
            .executeTakeFirst();
          if (already) await tx.deleteFrom("core_files_attachments").where("id", "=", a.id).execute();
          else await tx.updateTable("core_files_attachments").set({ file_id: keep }).where("id", "=", a.id).execute();
        }
        await tx.updateTable("core_files_files").set({ same_as: keep }).where("id", "=", copy).execute();
      });
      folded++;
    }
  }
  if (folded > 0) console.log(`[core-files] org ${orgId}: folded ${folded} stored cop${folded === 1 ? "y" : "ies"} into the file holding the same bytes`);
  return folded;
}

/** Call from onBoot. A registered pass: the kernel's walk, budget and
 *  stagger, never a walk of its own at boot. */
export function registerSameBytesHeal(): void {
  registerHealPass({
    name: "core-files.heal-same-bytes",
    shim: "modules/core-files/src/heal-same-bytes.ts",
    module: "core-files",
    visit: ({ orgId, db }) => healSameBytesIn(orgId, db as Kysely<CoreFilesDB>),
  });
}
