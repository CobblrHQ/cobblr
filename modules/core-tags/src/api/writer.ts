import { registerDeletedTagAssignments } from "../deletion-participant.js";
import { registerDeletedTagsHeal } from "../heal-deleted-records.js";
// In-process entity writer for core-tags:tag.
//
// The assistant's change ledger undoes a delete through a kind's writer
// (restore) and keeps the state to come back to with its snapshot. With no
// writer, undoing a tag delete made a lookalike tag under a new id and
// carried by nothing; now restore finds what the delete kept (tag-writes.ts)
// and puts the tag back on every record that carried it.
import { platform, imageId, restoreRow, snapshotRow, restoreRowTree, snapshotRowTree } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreTagsDB } from "../db.js";
import { createTag, deleteTagKept, restoreTag, updateTag } from "../tag-writes.js";

let registered = false;
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export function registerTagWriter(): void {
  if (registered) return;
  registered = true;
  registerDeletedTagsHeal();
  registerDeletedTagAssignments();
  const dbOf = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<CoreTagsDB>;
  platform().entities.registerWriter("core-tags:tag", {
    table: "core_tags_tags",
    async create(orgId, fields) {
      const row = await createTag(await dbOf(orgId), { orgId, userId: null }, {
        name: String(fields.name ?? ""),
        color: str(fields.color),
        parent_id: str(fields.parent_id),
        icon: str(fields.icon),
      });
      return row.id;
    },
    async update(orgId, id, fields) {
      const patch: Record<string, unknown> = {};
      if (fields.name !== undefined) patch.name = String(fields.name).trim();
      for (const k of ["color", "parent_id", "icon"] as const) if (fields[k] !== undefined) patch[k] = str(fields[k]);
      if (fields.pinned !== undefined) patch.pinned = fields.pinned === true;
      await updateTag(await dbOf(orgId), { orgId, userId: null }, id, patch);
    },
    async delete(orgId, id) {
      await deleteTagKept(await dbOf(orgId), orgId, id, null);
    },
    async restore(orgId, image) {
      const id = imageId(image);
      const db = await dbOf(orgId);
      if (id && (await restoreTag(db, orgId, id))) return;
      await restoreRow(db, "core_tags_tags", image);
    },
    async restoreDeletion(orgId, snapshot) {
      const id = imageId(snapshot.image);
      const db = await dbOf(orgId);
      if (id && await restoreTag(db, orgId, id)) return;
      await restoreRowTree(db, "core_tags_tags", snapshot, "core_tags_");
    },
    async snapshotDeletion(orgId, id) {
      return snapshotRowTree(await dbOf(orgId), "core_tags_tags", id, "core_tags_");
    },
    async snapshot(orgId, id) {
      return snapshotRow(await dbOf(orgId), "core_tags_tags", id);
    },
  });
}
