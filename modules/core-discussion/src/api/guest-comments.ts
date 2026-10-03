// A comment from someone outside the workspace, arriving through a share
// (#4627 §2: the friend's comments on a shared copy appear in the original's
// Discussion, and the owner's replies appear on the copy; one thread, two
// workspaces).
//
// The platform's sharing code knows nothing of this module and this module
// knows nothing of shares: the platform announces "a comment arrived for this
// record" as an event, and this puts it in the record's conversation as a
// guest's, named as it arrived, once (external_ref), and fans it out like any
// other comment. The posted event says author_kind "guest", which is how the
// sharing code knows not to send it straight back.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { SHARE_COMMENT_ARRIVED } from "@cobblr/platform-contract/share-offer";
import type { CoreDiscussionDB } from "../db.js";
import { fanOutComment } from "./after-comment.js";
import { ensureConversation, normaliseSource } from "./conversations.js";

interface Arrived {
  orgId?: unknown;
  kind?: unknown;
  id?: unknown;
  body?: unknown;
  author_name?: unknown;
  external_ref?: unknown;
}

export function registerGuestComments(): void {
  platform().events.on(SHARE_COMMENT_ARRIVED, "core-discussion", async (payload) => {
    const p = (payload ?? {}) as Arrived;
    const orgId = typeof p.orgId === "string" ? p.orgId : "";
    const kind = typeof p.kind === "string" ? p.kind : "";
    const id = typeof p.id === "string" ? p.id : "";
    const body = typeof p.body === "string" ? p.body.slice(0, 10_000) : "";
    const ref = typeof p.external_ref === "string" ? p.external_ref : "";
    const name = (typeof p.author_name === "string" && p.author_name.trim()) || "Someone you share with";
    if (!orgId || !kind.includes(":") || !id || !body.trim() || !ref) return;
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreDiscussionDB>;
    const seen = await db.selectFrom("core_discussion_comments").select("id").where("external_ref", "=", ref).executeTakeFirst();
    if (seen) return;
    const [mod, type] = kind.split(":") as [string, string];
    const src = await normaliseSource(orgId, { source_module: mod, source_type: type });
    const conversationId = await ensureConversation(db, { ...src, source_id: id });
    const comment = await db
      .insertInto("core_discussion_comments")
      .values({ conversation_id: conversationId, author_kind: "guest", author_user_id: null, author_name: name, external_ref: ref, body })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!comment) return;
    await fanOutComment(db, {
      orgId,
      conversationId,
      commentId: comment.id,
      body,
      authorUserId: null,
      authorName: name,
      authorKind: "guest",
      source: { ...src, source_id: id },
    });
  });
}
