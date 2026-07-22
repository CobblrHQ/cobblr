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

let registered = false;

function splitKind(kind: string): { source_module: string; source_type: string } | null {
  const [source_module, source_type] = kind.split(":");
  return source_module && source_type ? { source_module, source_type } : null;
}

export function registerTagActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-tags.tag-record", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const tagName = String((ctx.args as { tag_name?: unknown } | null)?.tag_name ?? "").trim();
    if (!tagName) return { ok: false, error: "tag_name required" };
    const src = splitKind(entity.kind);
    if (!src) return { ok: false, error: `bad entity kind "${entity.kind}"` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;

    // Resolve to a tag id — create on the fly if no such tag yet (the same
    // attach-by-name behavior the /attachments route has).
    const existing = await db
      .selectFrom("core_tags_tags")
      .select("id")
      .where(sql`lower(name)`, "=", tagName.toLowerCase())
      .executeTakeFirst();
    const tagId =
      existing?.id ??
      (
        await db
          .insertInto("core_tags_tags")
          .values({ name: tagName })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;

    // Idempotent on (tag, entity).
    const already = await db
      .selectFrom("core_tags_assignments")
      .select("id")
      .where("tag_id", "=", tagId)
      .where("source_module", "=", src.source_module)
      .where("source_type", "=", src.source_type)
      .where("source_id", "=", entity.id)
      .executeTakeFirst();
    if (already) return { ok: true, tag_id: tagId, attachment_id: already.id, already_tagged: true };

    const row = await db
      .insertInto("core_tags_assignments")
      .values({
        tag_id: tagId,
        source_module: src.source_module,
        source_type: src.source_type,
        source_id: entity.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await platform().events.emit("core-tags.assignment.created", {
      orgId: ctx.orgId,
      tagId,
      source_module: src.source_module,
      source_type: src.source_type,
      source_id: entity.id,
    });
    return { ok: true, tag_id: tagId, attachment_id: row.id };
  });

  platform().actions.registerHandler("core-tags.untag-record", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const tagName = String((ctx.args as { tag_name?: unknown } | null)?.tag_name ?? "").trim();
    if (!tagName) return { ok: false, error: "tag_name required" };
    const src = splitKind(entity.kind);
    if (!src) return { ok: false, error: `bad entity kind "${entity.kind}"` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTagsDB>;

    const tag = await db
      .selectFrom("core_tags_tags")
      .select("id")
      .where(sql`lower(name)`, "=", tagName.toLowerCase())
      .executeTakeFirst();
    if (!tag) return { ok: true, removed: false, reason: `no tag named "${tagName}"` };

    const row = await db
      .deleteFrom("core_tags_assignments")
      .where("tag_id", "=", tag.id)
      .where("source_module", "=", src.source_module)
      .where("source_type", "=", src.source_type)
      .where("source_id", "=", entity.id)
      .returning("id")
      .executeTakeFirst();
    if (!row) return { ok: true, removed: false, reason: "not tagged with that" };
    await platform().events.emit("core-tags.assignment.deleted", {
      orgId: ctx.orgId,
      tagId: tag.id,
      source_module: src.source_module,
      source_type: src.source_type,
      source_id: entity.id,
    });
    return { ok: true, removed: true };
  });
}
