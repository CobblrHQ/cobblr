// Everything that happens AFTER a comment row exists — in one place, because it
// existed in two and one of them was empty.
//
// A comment can be posted through two doors: the web route, and the
// `core-discussion:post-comment` action (which is what a Discord Reply invokes).
// The route did the full job — mention links, follows, notifications, the
// posted event. The action handler inserted the row, emitted the event, and did
// NOTHING ELSE. So a reply sent from Discord saved perfectly and told no one:
// the person who mentioned you never heard back, no mention links were written,
// and the replier did not start following the thread they had just spoken in.
//
// Silence again — the same failure shape as every other bug this feature has
// produced. Nothing errors when a fan-out simply is not called.
//
// The fix is structural rather than a patch: this function IS the fan-out, and
// both doors call it. A third door added later (email reply-by-token is the
// obvious one) gets the whole job by calling one function, and cannot
// half-implement it by forgetting a step, because the steps are not visible
// from outside.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { keepMembers } from "@cobblr/platform-contract/membership";
import { isWorkspaceRoom } from "@cobblr/platform-contract/workspace-room";
import { reconcileMentions } from "./reconcile.js";
import { followRecord, notifyAboutComment } from "./audience.js";
import { userMentions } from "../mentions.js";
import type { CoreDiscussionDB } from "../db.js";

export interface CommentFanOutArgs {
  orgId: string;
  conversationId: string;
  commentId: string;
  body: string;
  authorUserId: string | null;
  /** Shown in the notification ("<name> mentioned you in ..."). Callers that
   *  have a session pass the display name; the action door passes the actor's
   *  name off the invoke event. */
  authorName: string;
  source: { source_module: string; source_type: string; source_id: string };
  /** The workspace's name, for the room's label. The web route has it on the
   *  tenant context; the action context does not carry it, so that door falls
   *  back to the honest generic — "your workspace" reads fine in a DM, and a
   *  wrong name would not. */
  roomLabel?: string;
}

/**
 * Fan a freshly inserted comment out to everything that reacts to one:
 * mention links, the conversation reopening, follows, notifications, and the
 * posted event. Idempotence is not required — this runs exactly once per
 * comment, from whichever door inserted it.
 */
export async function fanOutComment(db: Kysely<CoreDiscussionDB>, args: CommentFanOutArgs): Promise<void> {
  const { source } = args;
  const room = isWorkspaceRoom(source);
  const kind = `${source.source_module}:${source.source_type}`;

  // The record's own name and page. Resolved here so both doors agree: the
  // fallback label is the kind (never the raw sentinel — the room's label is
  // the workspace), and the link is the record's detailUrl when the resolver
  // offers one. The ROOM's page is the workspace discussion; a notification
  // that cannot take you to the conversation it announces makes the reader do
  // the finding themselves (the rule lint:notification-deep-links exists for).
  // The room's label is the workspace's name. The web door passes it from its
  // tenant context (no query); any other door gets it from the contract, so a
  // Discord reply's fan-out no longer says "in your workspace" when the name
  // is one accessor away.
  let recordLabel = room
    ? args.roomLabel ||
      (await platform().notifications.orgName(args.orgId).catch(() => null)) ||
      "your workspace"
    : kind;
  let link: string | null = room ? "/discussion" : null;
  if (!room) {
    try {
      const resolved = await platform().entities.lookup(args.orgId, kind, source.source_id);
      if (resolved?.title) recordLabel = resolved.title;
      if (resolved?.detailUrl) link = resolved.detailUrl;
    } catch {
      /* the name and link are niceties; the notification still has to go */
    }
  }

  await reconcileMentions(db, {
    orgId: args.orgId,
    conversationId: args.conversationId,
    commentId: args.commentId,
    body: args.body,
    record: { kind, id: source.source_id },
    userId: args.authorUserId,
  });

  // Posting into a settled conversation opens it again: a resolve is a
  // bookmark meaning "decided", never a lock.
  await db
    .updateTable("core_discussion_conversations")
    .set({ updated_at: new Date(), resolved_at: null, resolved_by: null })
    .where("id", "=", args.conversationId)
    .execute();

  // Speaking is following. You are then told when somebody answers, which is
  // the whole reason to say anything in a shared place.
  if (args.authorUserId) {
    await followRecord(db, {
      source,
      userId: args.authorUserId,
      reason: "commented",
    });
  }
  // Being NAMED also follows: you were pulled in, so you should hear the reply
  // without having to remember to come back. Members only (audit M-MENTION) —
  // a mention token can name any real uuid.
  const members = new Set(await platform().notifications.orgMemberIds(args.orgId));
  for (const named of keepMembers(userMentions(args.body), members)) {
    await followRecord(db, {
      source,
      userId: named,
      reason: "mentioned",
    });
  }

  await notifyAboutComment(db, {
    orgId: args.orgId,
    conversationId: args.conversationId,
    source,
    body: args.body,
    authorUserId: args.authorUserId,
    authorName: args.authorName,
    recordLabel,
    inRoom: room,
    link,
  });

  await platform().events.emit("core-discussion.comment.posted", {
    orgId: args.orgId,
    conversation_id: args.conversationId,
    comment_id: args.commentId,
    ...source,
    author_user_id: args.authorUserId,
  });
}
