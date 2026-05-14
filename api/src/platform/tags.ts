// Tag primitive. Cross-module polymorphic labels.
// All writes idempotent — re-attaching a tag is a no-op.

import { meta } from "../db/meta.js";

export interface TagRef {
  module: string;
  entityType: string;
  entityId: string;
}

/** Look up or create a tag by name, then attach it to the entity.
 *  No-ops on re-attach. */
export async function attach(
  orgId: string,
  ref: TagRef,
  name: string,
  color: string | null = null,
): Promise<{ tagId: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Tag name required");

  const existing = await meta
    .selectFrom("tags")
    .select("id")
    .where("org_id", "=", orgId)
    .where("name", "=", trimmedName)
    .executeTakeFirst();

  const tagId =
    existing?.id ??
    (
      await meta
        .insertInto("tags")
        .values({ org_id: orgId, name: trimmedName, color })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

  await meta
    .insertInto("tag_assignments")
    .values({
      tag_id: tagId,
      module_name: ref.module,
      entity_type: ref.entityType,
      entity_id: ref.entityId,
    })
    .onConflict((b) => b.columns(["tag_id", "module_name", "entity_type", "entity_id"]).doNothing())
    .execute();

  return { tagId };
}

export async function detach(
  orgId: string,
  ref: TagRef,
  name: string,
): Promise<void> {
  const tag = await meta
    .selectFrom("tags")
    .select("id")
    .where("org_id", "=", orgId)
    .where("name", "=", name.trim())
    .executeTakeFirst();
  if (!tag) return;
  await meta
    .deleteFrom("tag_assignments")
    .where("tag_id", "=", tag.id)
    .where("module_name", "=", ref.module)
    .where("entity_type", "=", ref.entityType)
    .where("entity_id", "=", ref.entityId)
    .execute();
}

export async function listForEntity(
  ref: TagRef,
): Promise<{ id: string; name: string; color: string | null }[]> {
  return meta
    .selectFrom("tag_assignments as a")
    .innerJoin("tags as t", "t.id", "a.tag_id")
    .select(["t.id", "t.name", "t.color"])
    .where("a.module_name", "=", ref.module)
    .where("a.entity_type", "=", ref.entityType)
    .where("a.entity_id", "=", ref.entityId)
    .execute();
}

export interface TaggedEntity {
  module_name: string;
  entity_type: string;
  entity_id: string;
}

/** All entities (across modules) carrying a given tag in an org. */
export async function getEntitiesByTag(
  orgId: string,
  tagName: string,
): Promise<TaggedEntity[]> {
  return meta
    .selectFrom("tags as t")
    .innerJoin("tag_assignments as a", "a.tag_id", "t.id")
    .select(["a.module_name", "a.entity_type", "a.entity_id"])
    .where("t.org_id", "=", orgId)
    .where("t.name", "=", tagName.trim())
    .execute();
}
