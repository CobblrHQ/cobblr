// The invokable side of discussion, so Cobb, MCP and wires reach the same
// conversation the UI writes to rather than a parallel one.
//
// Both handlers READ ctx.entity — they act on the record they were invoked on,
// which is what makes them honestly entity-scoped
// (scripts/lint-entity-action-uses-entity.ts).

import { type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { CoreDiscussionDB } from "../db.js";

let registered = false;

/** `<module>:<type>` → the two halves of the source triple, exactly as
 *  EntityAttachments splits it on the UI side. */
function splitKind(kind: string): { source_module: string; source_type: string } | null {
  const [source_module, source_type] = kind.split(":");
  return source_module && source_type ? { source_module, source_type } : null;
}

/** Same normalisation the HTTP routes do: an instance kind discusses under its
 *  BASE kind, so a record has one conversation however you reached it. */
async function baseSplit(orgId: string, kind: string) {
  let resolved = kind;
  try {
    resolved = await platform().entities.baseKindOf(orgId, kind);
  } catch {
    /* unregistered kinds are still discussable */
  }
  return splitKind(resolved);
}

export function registerDiscussionActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-discussion.post-comment", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as { body?: unknown; in_reply_to?: unknown };
    const body = String(args.body ?? "").trim();
    if (!body) return { ok: false, error: "body required" };
    const src = await baseSplit(ctx.orgId, entity.kind);
    if (!src) return { ok: false, error: `bad entity kind "${entity.kind}"` };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreDiscussionDB>;
    const conv = await db
      .insertInto("core_discussion_conversations")
      .values({ ...src, source_id: entity.id })
      .onConflict((oc) => oc.columns(["source_module", "source_type", "source_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    const conversationId =
      conv?.id ??
      (
        await db
          .selectFrom("core_discussion_conversations")
          .select("id")
          .where("source_module", "=", src.source_module)
          .where("source_type", "=", src.source_type)
          .where("source_id", "=", entity.id)
          .executeTakeFirstOrThrow()
      ).id;

    const comment = await db
      .insertInto("core_discussion_comments")
      .values({
        conversation_id: conversationId,
        in_reply_to: typeof args.in_reply_to === "string" ? args.in_reply_to : null,
        author_kind: "user",
        author_user_id: ctx.userId ?? null,
        body,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .updateTable("core_discussion_conversations")
      .set({ updated_at: new Date(), resolved_at: null, resolved_by: null })
      .where("id", "=", conversationId)
      .execute();

    await platform().events.emit("core-discussion.comment.posted", {
      orgId: ctx.orgId,
      conversation_id: conversationId,
      comment_id: comment.id,
      ...src,
      source_id: entity.id,
      author_user_id: ctx.userId ?? null,
    });
    return { ok: true, comment_id: comment.id };
  });

  platform().actions.registerHandler("core-discussion.resolve-conversation", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as { resolved?: unknown };
    // Default to resolving: "mark this settled" is the ask, and reopening is
    // what posting into it does anyway.
    const resolved = args.resolved === undefined ? true : args.resolved === true;
    const src = await baseSplit(ctx.orgId, entity.kind);
    if (!src) return { ok: false, error: `bad entity kind "${entity.kind}"` };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreDiscussionDB>;
    const updated = await db
      .updateTable("core_discussion_conversations")
      .set(
        resolved
          ? { resolved_at: new Date(), resolved_by: ctx.userId ?? null, updated_at: new Date() }
          : { resolved_at: null, resolved_by: null, updated_at: new Date() },
      )
      .where("source_module", "=", src.source_module)
      .where("source_type", "=", src.source_type)
      .where("source_id", "=", entity.id)
      .returning("id")
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "nothing has been said about this yet" };

    if (resolved) {
      await platform().events.emit("core-discussion.conversation.resolved", {
        orgId: ctx.orgId,
        conversation_id: updated.id,
        resolved_by: ctx.userId ?? null,
      });
    }
    return { ok: true, resolved };
  });
}
