// Every write to tags and their assignments, in one place.
//
// The routes and the actions (the assistant, wires, apps) both call these, so
// they cannot come to mean different things. Each one answers a name
// collision instead of throwing it, survives two callers doing the same thing
// at once, emits its event and writes the workspace activity log. Before
// this, the routes and the actions each had their own copy: a rename onto a
// taken name answered 500, two attaches of one new tag raced and one of them
// answered 500, and only "tag created" was ever written down.

import { sql, type Kysely } from "kysely";
import { platform, restoreRowTree, RecordRestoreRefused } from "@cobblr/platform-contract";
import type { CoreTagsDB } from "./db.js";

type Db = Kysely<CoreTagsDB>;

/** Who is writing, for the log. */
export interface Writer {
  orgId: string;
  userId: string | null;
}

/** The record a tag goes on: module + type + id, the polymorphic triple. */
export interface Source {
  source_module: string;
  source_type: string;
  source_id: string;
}

/** A write that would give two tags one name (the index is case-blind). */
export class TagNameTaken extends Error {
  constructor(readonly existing: { id: string; name: string } & Record<string, unknown>) {
    super(`a tag called "${existing.name}" already exists`);
  }
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string }).code === "23505";

async function byName(db: Db, name: string) {
  return db.selectFrom("core_tags_tags").selectAll().where(sql`lower(name)`, "=", name.trim().toLowerCase()).executeTakeFirst();
}

async function log(w: Writer, action: string, ref: { module: string; entityType: string; entityId: string }, diff: unknown, before?: unknown): Promise<void> {
  await platform().activity.log({ orgId: w.orgId, userId: w.userId, action, ref, diff, ...(before !== undefined ? { before } : {}) });
}

const tagRef = (id: string) => ({ module: "core-tags", entityType: "tag", entityId: id });
const recordRef = (s: Source) => ({ module: s.source_module, entityType: s.source_type, entityId: s.source_id });

/** Create a tag. Throws TagNameTaken when the name is already a tag's. */
export async function createTag(
  db: Db,
  w: Writer,
  v: { name: string; color?: string | null; parent_id?: string | null; icon?: string | null },
) {
  let row;
  try {
    row = await db
      .insertInto("core_tags_tags")
      .values({ name: v.name.trim(), color: v.color ?? null, parent_id: v.parent_id ?? null, icon: v.icon ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await byName(db, v.name);
      if (existing) throw new TagNameTaken(existing);
    }
    throw err;
  }
  await platform().events.emit("core-tags.tag.created", { orgId: w.orgId, tagId: row.id, name: row.name });
  await log(w, "tag_created", tagRef(row.id), { name: row.name });
  return row;
}

/** The tag with this name, made if there is none. Two callers asking for
 *  the same new name at once get the same tag, and it is created once. */
export async function ensureTag(db: Db, w: Writer, name: string, color?: string | null): Promise<{ id: string; name: string }> {
  const found = await byName(db, name);
  if (found) return found;
  try {
    return await createTag(db, w, { name, color });
  } catch (err) {
    if (err instanceof TagNameTaken) return err.existing;
    throw err;
  }
}

/** Change a tag. Null when there is no such tag; throws TagNameTaken when
 *  the new name belongs to another tag. The log says what each field was. */
export async function updateTag(db: Db, w: Writer, id: string, patch: Record<string, unknown>) {
  const before = await db.selectFrom("core_tags_tags").selectAll().where("id", "=", id).executeTakeFirst();
  if (!before) return null;
  const set: Record<string, unknown> = { ...patch, updated_at: new Date() };
  if (typeof set.name === "string") set.name = set.name.trim();
  let row;
  try {
    row = await db.updateTable("core_tags_tags").set(set).where("id", "=", id).returningAll().executeTakeFirst();
  } catch (err) {
    if (isUniqueViolation(err) && typeof set.name === "string") {
      const existing = await byName(db, set.name);
      if (existing && existing.id !== id) throw new TagNameTaken(existing);
    }
    throw err;
  }
  if (!row) return null;
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    const from = (before as Record<string, unknown>)[k] ?? null;
    const to = (row as Record<string, unknown>)[k] ?? null;
    if (from !== to) changed[k] = { from, to };
  }
  if (Object.keys(changed).length) {
    await platform().events.emit("core-tags.tag.updated", { orgId: w.orgId, tagId: row.id, name: row.name, changed });
    // The patch with the row as it was: the log works out old → new itself.
    await log(w, "tag_updated", tagRef(row.id), patch, before);
  }
  return row;
}

/** Delete a tag; its assignments go with it (the database cascades). */
export async function deleteTag(db: Db, w: Writer, id: string) {
  const on = await db.selectFrom("core_tags_assignments").select(({ fn }) => fn.countAll<number>().as("n")).where("tag_id", "=", id).executeTakeFirst();
  const row = await db.deleteFrom("core_tags_tags").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
  if (!row) return null;
  await platform().events.emit("core-tags.tag.deleted", { orgId: w.orgId, tagId: row.id, name: row.name });
  await log(w, "tag_deleted", tagRef(row.id), { name: row.name, was_on: Number(on?.n ?? 0) });
  return row;
}

/** Put a tag on a record. Idempotent on (tag, record), including when two
 *  callers do it at once: the loser reads the winner's row. */
export async function attachTag(db: Db, w: Writer, tag: { id: string; name: string }, s: Source) {
  const inserted = await db
    .insertInto("core_tags_assignments")
    .values({ tag_id: tag.id, source_module: s.source_module, source_type: s.source_type, source_id: s.source_id })
    .onConflict((oc) => oc.columns(["tag_id", "source_module", "source_type", "source_id"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    const row = await db
      .selectFrom("core_tags_assignments")
      .selectAll()
      .where("tag_id", "=", tag.id)
      .where("source_module", "=", s.source_module)
      .where("source_type", "=", s.source_type)
      .where("source_id", "=", s.source_id)
      .executeTakeFirstOrThrow();
    return { row, created: false };
  }
  await platform().events.emit("core-tags.assignment.created", { orgId: w.orgId, tagId: tag.id, ...s });
  await log(w, "tag_attached", recordRef(s), { tag: tag.name, tag_id: tag.id });
  return { row: inserted, created: true };
}

/** Take a tag off a record, by the assignment's id or by (tag, record). */
export async function detachTag(db: Db, w: Writer, by: { id: string } | { tag_id: string; source: Source }) {
  let q = db.deleteFrom("core_tags_assignments");
  if ("id" in by) q = q.where("id", "=", by.id);
  else
    q = q
      .where("tag_id", "=", by.tag_id)
      .where("source_module", "=", by.source.source_module)
      .where("source_type", "=", by.source.source_type)
      .where("source_id", "=", by.source.source_id);
  const row = await q.returning(["id", "tag_id", "source_module", "source_type", "source_id"]).executeTakeFirst();
  if (!row) return null;
  const tag = await db.selectFrom("core_tags_tags").select("name").where("id", "=", row.tag_id).executeTakeFirst();
  const s: Source = { source_module: row.source_module, source_type: row.source_type, source_id: row.source_id };
  await platform().events.emit("core-tags.assignment.deleted", { orgId: w.orgId, tagId: row.tag_id, ...s });
  await log(w, "tag_detached", recordRef(s), { tag: tag?.name ?? null, tag_id: row.tag_id });
  return row;
}

/** Move every assignment from one tag onto another and delete the source.
 *  An assignment the target already has is dropped rather than doubled.
 *  Every record whose tags changed hears of it: the moved ones gain the
 *  target and lose the source, the dropped ones lose the source. */
export async function mergeTag(db: Db, w: Writer, source: { id: string; name: string }, target: { id: string; name: string }) {
  const { moved, dropped } = await db.transaction().execute(async (trx) => {
    const dropped = await sql<Source>`
      delete from core_tags_assignments a
      where a.tag_id = ${source.id}
        and exists (
          select 1 from core_tags_assignments b
          where b.tag_id = ${target.id}
            and b.source_module = a.source_module
            and b.source_type = a.source_type
            and b.source_id = a.source_id
        )
      returning a.source_module, a.source_type, a.source_id
    `.execute(trx);
    const moved = await trx
      .updateTable("core_tags_assignments")
      .set({ tag_id: target.id })
      .where("tag_id", "=", source.id)
      .returning(["source_module", "source_type", "source_id"])
      .execute();
    await trx.deleteFrom("core_tags_tags").where("id", "=", source.id).execute();
    return { moved, dropped: dropped.rows };
  });
  const events = platform().events;
  for (const s of [...moved, ...dropped]) await events.emit("core-tags.assignment.deleted", { orgId: w.orgId, tagId: source.id, ...s });
  for (const s of moved) await events.emit("core-tags.assignment.created", { orgId: w.orgId, tagId: target.id, ...s });
  await events.emit("core-tags.tag.deleted", { orgId: w.orgId, tagId: source.id, name: source.name });
  await log(w, "tag_merged", tagRef(target.id), { from: source.name, from_id: source.id, into: target.name, moved: moved.length, already_there: dropped.length });
  return moved.length;
}

// Deleting or merging a tag, and putting it back.
//
// Either one changes every record carrying the tag, across the workspace, in
// one press, and neither could be undone: a wrong merge folded two meanings
// into one for good. Before either, this writes down the tag row, every
// assignment it had (ids included: a merge MOVES them to the other tag, and
// drops the ones that other tag already had) and the tags inside it. Putting
// it back restores the tag under its own id, moves each moved assignment back,
// re-adds each dropped one, and puts its child tags back under it. Every door
// reaches the same undo: the page's Undo, the merge action's registered undo,
// and the assistant's ledger through the tag writer's restore.

export class TagRestoreRefused extends RecordRestoreRefused {}

interface KeptAssignment {
  id: string;
  tag_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  created_at: string;
}

const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

/** Write down what a delete or merge of `id` is about to take. Null when there
 *  is no such tag. */
async function keep(db: Db, orgId: string, id: string, by: string | null, mergedInto: string | null) {
  const row = await db.selectFrom("core_tags_tags").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const assignments = await db.selectFrom("core_tags_assignments").selectAll().where("tag_id", "=", id).execute();
  const children = (await db.selectFrom("core_tags_tags").select("id").where("parent_id", "=", id).execute()).map((c) => c.id);
  await platform().deletedRecords.keep(orgId, "core-tags:tag", id, row, { row, name: row.name, assignments, children, merged_into: mergedInto }, by);
  return { name: row.name, assignments: assignments.length };
}

/** Delete a tag, keeping what an undo needs. */
export async function deleteTagKept(db: Db, orgId: string, id: string, by: string | null) {
  const kept = await keep(db, orgId, id, by, null);
  if (!kept) return null;
  await deleteTag(db, { orgId, userId: by }, id);
  return kept;
}

/** Merge a tag into another, keeping what an undo needs. */
export async function mergeTagKept(db: Db, orgId: string, id: string, into: string, by: string | null) {
  const target = await db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", into).executeTakeFirst();
  if (!target) return null;
  const kept = await keep(db, orgId, id, by, into);
  if (!kept) return null;
  const moved = await mergeTag(db, { orgId, userId: by }, { id, name: kept.name }, target);
  return { ...kept, moved };
}

/** Put a deleted or merged tag back, on every record that carried it. Null
 *  when it was not deleted, or too long ago. Refused when another tag has
 *  taken its name since, since names are unique. */
export async function restoreTag(db: Db, orgId: string, id: string, by: string | null = null) {
  const saved = await platform().deletedRecords.get(orgId, "core-tags:tag", id);
  const kept = saved?.details as { row: unknown; assignments: unknown; children: unknown; merged_into: string | null } | null;
  if (!kept) return null;
  const row = parse<Record<string, unknown> & { name: string; parent_id: string | null }>(kept.row);
  const clash = await db
    .selectFrom("core_tags_tags")
    .select(["id", "name"])
    .where(sql`lower(name)`, "=", row.name.toLowerCase())
    .where("id", "!=", id)
    .executeTakeFirst();
  if (clash) throw new TagRestoreRefused(`A tag called ${clash.name} exists now, so ${row.name} cannot come back under that name. Rename one of them first.`);
  // Its parent may have gone since: then it comes back at the top level.
  const parentThere =
    !row.parent_id || !!(await db.selectFrom("core_tags_tags").select("id").where("id", "=", row.parent_id).executeTakeFirst());
  await restoreRowTree(db, "core_tags_tags", { image: parentThere ? row : { ...row, parent_id: null } }, "core_tags_");

  let putBack = 0;
  for (const a of parse<KeptAssignment[]>(kept.assignments)) {
    const now = await db.selectFrom("core_tags_assignments").select(["id", "tag_id"]).where("id", "=", a.id).executeTakeFirst();
    if (now) {
      // Moved onto the tag it was merged into: move it back.
      if (now.tag_id !== id) await db.updateTable("core_tags_assignments").set({ tag_id: id }).where("id", "=", a.id).execute();
      putBack++;
      continue;
    }
    // Removed with the tag, or dropped by the merge because the other tag
    // already carried that record: add it again.
    const added = await db
      .insertInto("core_tags_assignments")
      .values({ id: a.id, tag_id: id, source_module: a.source_module, source_type: a.source_type, source_id: a.source_id, created_at: new Date(a.created_at) })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(added.numInsertedOrUpdatedRows ?? 0n) > 0) putBack++;
  }
  const children = parse<string[]>(kept.children);
  if (children.length) {
    await db.updateTable("core_tags_tags").set({ parent_id: id }).where("id", "in", children).where("parent_id", "is", null).execute();
  }
  await platform().deletedRecords.forget(orgId, "core-tags:tag", id);
  await platform().events.emit("core-tags.tag.created", { orgId, tagId: id, name: row.name });
  await log({ orgId, userId: by }, "tag_restored", tagRef(id), { name: row.name, put_back_on: putBack, was_merged_into: kept.merged_into ?? null });
  return { name: row.name, assignments: putBack, mergedInto: kept.merged_into };
}

export async function restoreDeletedAssignments(db: Db, image: unknown): Promise<void> {
  for (const row of image as Array<{ id: string; tag_id: string; source_module: string; source_type: string; source_id: string; created_at: string }>) {
    if (!await db.selectFrom("core_tags_tags").select("id").where("id", "=", row.tag_id).executeTakeFirst()) continue;
    await db.insertInto("core_tags_assignments").values({ ...row, created_at: new Date(row.created_at) }).onConflict((oc) => oc.doNothing()).execute();
  }
}
export async function forgetLegacyDeletedTag(db: Db, id: string): Promise<void> {
  await db.deleteFrom("core_tags_deleted").where("id", "=", id).execute();
}

export async function purgeDeletedAssignments(db: Db, image: unknown): Promise<void> {
  for (const row of image as Array<{ id: string; tag_id: string; source_id: string }>) {
    await db.deleteFrom("core_tags_assignments").where("id", "=", row.id).where("tag_id", "=", row.tag_id).where("source_id", "=", row.source_id).execute();
  }
}
