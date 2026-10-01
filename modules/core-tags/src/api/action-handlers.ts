// Action handlers — the invokable side of tagging, so wires, Tier-B apps, and
// the AI surfaces (Ask Cobb / MCP, via invoke_action) can label records without
// speaking the /attachments HTTP shape. Same semantics as the routes:
//   - core-tags.tag-record   — attach by name (tag created on the fly);
//                              idempotent on (tag, entity).
//   - core-tags.untag-record — detach by name; no-op if not attached.
// The entity comes from ctx.entity; its kind splits module:type exactly the
// way the UI's EntityAttachments does.

import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { CoreTagsDB } from "../db.js";
import { TagRestoreRefused, mergeTagKept, restoreTag } from "../tag-writes.js";
import { countOf } from "@cobblr/platform-contract/plural";
import { attachTag, detachTag, ensureTag } from "../tag-writes.js";
import { splitEntityKind } from "@cobblr/platform-contract/entity-kind";

let registered = false;

/** `<module>:<type>` → the two halves of the source triple, by the
 *  contract's one split (the kernel's tag seam uses it too), or null for a
 *  kind that is not one. */
function splitKind(kind: string): { source_module: string; source_type: string } | null {
  try {
    const { module, type } = splitEntityKind(kind);
    return { source_module: module, source_type: type };
  } catch {
    return null;
  }
}

export function registerTagActionHandlers(): void {
  registerUndos();
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-tags.tag-record", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const tagName = String((ctx.args as { tag_name?: unknown } | null)?.tag_name ?? "").trim();
    if (!tagName) return { ok: false, error: "tag_name required" };
    const src = splitKind(entity.kind);
    // ALLOW-INTERNAL-NOUN: echoes the caller's own word for a kind that is not here; there are no words for it
    if (!src) return { ok: false, error: `no kind of record called "${entity.kind}" here` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;

    const w = { orgId: ctx.orgId, userId: ctx.userId };
    const tag = await ensureTag(db, w, tagName);
    const { row, created } = await attachTag(db, w, tag, { ...src, source_id: entity.id });
    if (!created) return { ok: true, tag_id: tag.id, attachment_id: row.id, already_tagged: true, tag_name: tagName };
    return { ok: true, tag_id: tag.id, attachment_id: row.id, tag_name: tagName };
  });

  platform().actions.registerHandler("core-tags.untag-record", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const tagName = String((ctx.args as { tag_name?: unknown } | null)?.tag_name ?? "").trim();
    if (!tagName) return { ok: false, error: "tag_name required" };
    const src = splitKind(entity.kind);
    // ALLOW-INTERNAL-NOUN: echoes the caller's own word for a kind that is not here; there are no words for it
    if (!src) return { ok: false, error: `no kind of record called "${entity.kind}" here` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;

    const tag = await db
      .selectFrom("core_tags_tags")
      .select("id")
      .where(sql`lower(name)`, "=", tagName.toLowerCase())
      .executeTakeFirst();
    if (!tag) return { ok: true, removed: false, reason: `no tag named "${tagName}"` };

    const row = await detachTag(db, { orgId: ctx.orgId, userId: ctx.userId }, { tag_id: tag.id, source: { ...src, source_id: entity.id } });
    if (!row) return { ok: true, removed: false, reason: "not tagged with that", tag_name: tagName };
    return { ok: true, removed: true, tag_name: tagName };
  });

  // Merging two tags was reachable only by hand: the module had tag-record and
  // untag-record, and no way to say "these two mean the same thing". Tidying up
  // a tag list is exactly the chore someone asks for in words.
  // Exists only as the way back for a merge (and its own way back is the
  // merge again): the tag under its own id, on every record it was on.
  platform().actions.registerHandler("core-tags.restore-tag", async (ctx) => {
    const id = String((ctx.args as { tag_id?: unknown } | null)?.tag_id ?? "");
    if (!id) return { ok: false, error: "nothing to put back" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;
    try {
      const back = await restoreTag(db, ctx.orgId, id, ctx.userId ?? null);
      if (!back) return { ok: false, error: "that tag was not deleted recently enough to put back" };
      return { ok: true, result: { tag_id: id, merged_into: back.mergedInto, note: `Put ${back.name} back on ${countOf(back.assignments, "record")}.` } };
    } catch (e) {
      if (e instanceof TagRestoreRefused) return { ok: false, error: e.message };
      throw e;
    }
  });

  platform().actions.registerHandler("core-tags.merge", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const into =
      typeof args.into_tag_id === "string" && args.into_tag_id.trim() ? args.into_tag_id.trim() : "";
    if (!into) return { ok: false, error: "pass into_tag_id: the tag to keep" };
    if (into === entity.id) return { ok: false, error: "cannot merge a tag into itself" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;
    const [source, target] = await Promise.all([
      db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", entity.id).executeTakeFirst(),
      db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", into).executeTakeFirst(),
    ]);
    if (!source) return { ok: false, error: "that tag no longer exists" };
    if (!target) return { ok: false, error: `no tag with id ${into} to merge into` };

    const merged = await mergeTagKept(db, ctx.orgId, source.id, target.id, ctx.userId ?? null);
    const moved = merged?.moved ?? 0;
    return {
      ok: true,
      result: {
        merged: source.name,
        into: target.name,
        moved_assignments: moved,
        tag_id: source.id,
        note: `"${source.name}" is gone; everything it was on now carries "${target.name}".`,
      },
    };
  });
}

// Tagging is undone by untagging, and the other way round. A tag that was
// already there, or one that was not, changed nothing and hands back nothing.
function registerUndos(): void {
  platform().actions.registerUndo("core-tags.merge", (result) => {
    const id = (result as { result?: { tag_id?: unknown } } | null)?.result?.tag_id;
    return typeof id === "string" ? { action_id: "core-tags:restore-tag", args: { tag_id: id } } : null;
  });
  platform().actions.registerUndo("core-tags.restore-tag", (result) => {
    const r = (result as { result?: { tag_id?: unknown; merged_into?: unknown } } | null)?.result;
    if (typeof r?.tag_id !== "string" || typeof r.merged_into !== "string") return null;
    return { action_id: "core-tags:merge", entity_kind: "core-tags:tag", entity_id: r.tag_id, args: { into_tag_id: r.merged_into } };
  });
  platform().actions.registerUndo("core-tags.tag-record", (result, ctx) => {
    const r = result as { tag_name?: unknown; already_tagged?: unknown } | null;
    if (!ctx.entity || typeof r?.tag_name !== "string" || r.already_tagged) return null;
    return { action_id: "core-tags:untag-record", args: { tag_name: r.tag_name }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
  platform().actions.registerUndo("core-tags.untag-record", (result, ctx) => {
    const r = result as { tag_name?: unknown; removed?: unknown } | null;
    if (!ctx.entity || typeof r?.tag_name !== "string" || !r.removed) return null;
    return { action_id: "core-tags:tag-record", args: { tag_name: r.tag_name }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
}
