import { purgeDeletedAssignments, restoreDeletedAssignments } from "./tag-writes.js";
import { platform, type EntityRef } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreTagsDB } from "./db.js";

export function registerDeletedTagAssignments(): void {
  const dbOf = async (orgId: string) => await platform().tenants.getDb(orgId) as Kysely<CoreTagsDB>;
  const kinds = async (orgId: string, ref: EntityRef) => [...new Set([ref.kind, await platform().entities.baseKindOf(orgId, ref.kind)])].map((k) => k.split(":"));
  platform().deletedRecords.registerParticipant("core-tags.assignments", {
    snapshot: async (orgId, ref, snapshot) => {
      const children = snapshot?.related as { rows?: Array<{ row: { id?: string } }> } | undefined;
      const ids = [ref.id, ...(children?.rows ?? []).flatMap((r) => r.row.id ? [r.row.id] : [])];
      const pairs = await kinds(orgId, ref);
      return (await dbOf(orgId)).selectFrom("core_tags_assignments").selectAll().where("source_id", "in", ids)
        .where((eb) => eb.or(pairs.map(([module]) => eb("source_module", "=", module!)))).execute();
    },
    purge: async (orgId, _ref, image) => purgeDeletedAssignments(await dbOf(orgId), image),
    restore: async (orgId, _ref, image) => restoreDeletedAssignments(await dbOf(orgId), image),
  });
}
