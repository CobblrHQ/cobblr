// Who hears about a comment, and how loudly.
//
// A comment nobody sees is worthless, and a comment that pings everybody is
// worse — the second failure is the one that makes people turn a feature off.
// So there are exactly two volumes, and the difference between them is whether
// somebody was NAMED:
//
//   mentioned by name  → priority "high"   — interrupts, skips the delivery
//                                            window. Being addressed is not the
//                                            same event as activity nearby.
//   following / replied → priority "normal" — waits for the reader's delivery
//                                            window, i.e. batches into their
//                                            digest.
//
// Both go through the platform dispatcher, which already knows each user's
// channels, subscriptions and window (api/src/platform/delivery-windows.ts).
// This module does not batch anything itself: a second batching implementation
// would be a second set of rules to keep in step with the first.

import { platform } from "@cobblr/platform-contract";
import { keepMembers } from "@cobblr/platform-contract/membership";
import { userMentions } from "../mentions.js";
import { plainBody, excerpt } from "../plain-body.js";
import type { Kysely } from "kysely";
import type { CoreDiscussionDB } from "../db.js";

/** Split a comment's audience into the two volumes, dropping anyone who is not
 *  a CURRENT member of the workspace.
 *
 *  Pure so it can be tested without a DB. Membership is the gate on BOTH tiers:
 *  a `[[user:<uuid>]]` token names any real uuid the author cared to type, so
 *  an unfiltered `named` was a way to DM a stranger — a non-member on another
 *  workspace, or someone with no relationship at all — a Cobblr-branded message
 *  with attacker-chosen text (audit M-MENTION). Followers/speakers are filtered
 *  too, so a removed member with stale rows drops out here as well as at the
 *  platform dispatcher (audit M-EXMEMBER, defence in depth).
 *
 *  `named` (mentioned by name → high priority) wins over `rest` (following /
 *  spoke before → normal) when someone is both. */
export function recipientsFor(args: {
  /** Raw `userMentions(body)` — every `[[user:<uuid>]]` the author wrote. */
  mentioned: string[];
  /** Followers + prior speakers, author already excluded (from audienceFor). */
  audience: string[];
  authorUserId: string | null;
  /** Current members of the conversation's workspace (orgMemberIds). */
  members: ReadonlySet<string>;
}): { named: string[]; rest: string[] } {
  const named = keepMembers(
    args.mentioned.filter((u) => u !== args.authorUserId),
    args.members,
  );
  const namedSet = new Set(named);
  // Never the author — audienceFor already excludes them, but the rule belongs
  // to the pure function so it holds regardless of what the caller passes.
  const rest = keepMembers(args.audience, args.members).filter(
    (u) => u !== args.authorUserId && !namedSet.has(u),
  );
  return { named, rest };
}

/** Everyone who should hear, minus the person who just spoke.
 *
 *  Followers AND prior participants: following is Phase-3 machinery and a
 *  workspace that predates it still has conversations in it, so the people who
 *  have already spoken are treated as interested whether or not a follow row
 *  exists. */
export async function audienceFor(
  db: Kysely<CoreDiscussionDB>,
  args: {
    conversationId: string;
    source: { source_module: string; source_type: string; source_id: string };
    exclude: string | null;
  },
): Promise<string[]> {
  const [followers, speakers] = await Promise.all([
    db
      .selectFrom("core_discussion_follows")
      .select("user_id")
      .where("source_module", "=", args.source.source_module)
      .where("source_type", "=", args.source.source_type)
      .where("source_id", "=", args.source.source_id)
      .execute(),
    db
      .selectFrom("core_discussion_comments")
      .select("author_user_id")
      .where("conversation_id", "=", args.conversationId)
      .where("author_user_id", "is not", null)
      .distinct()
      .execute(),
  ]);
  const ids = new Set<string>();
  for (const f of followers) ids.add(f.user_id);
  for (const s of speakers) if (s.author_user_id) ids.add(s.author_user_id);
  if (args.exclude) ids.delete(args.exclude);
  return [...ids];
}

/** Follow a record, unless the user already follows it for a stronger reason.
 *  Commenting is an implicit follow; an EXPLICIT follow must not be downgraded
 *  by later commenting, or unfollowing would silently undo itself. */
export async function followRecord(
  db: Kysely<CoreDiscussionDB>,
  args: {
    source: { source_module: string; source_type: string; source_id: string };
    userId: string;
    reason: "commented" | "mentioned" | "explicit";
  },
): Promise<void> {
  await db
    .insertInto("core_discussion_follows")
    .values({ ...args.source, user_id: args.userId, reason: args.reason })
    .onConflict((oc) =>
      oc
        .columns(["source_module", "source_type", "source_id", "user_id"])
        .doNothing(),
    )
    .execute();
}

/** Tell the people who should know. Never the author: nobody needs telling
 *  about their own comment. */
export async function notifyAboutComment(
  db: Kysely<CoreDiscussionDB>,
  args: {
    orgId: string;
    conversationId: string;
    source: { source_module: string; source_type: string; source_id: string };
    body: string;
    authorUserId: string | null;
    authorName: string;
    recordLabel: string;
    /** True when the conversation is the workspace ROOM rather than a record.
     *  Changes the preposition, because you are IN a room and you comment ON a
     *  thing — and because the room's label is a workspace name, where
     *  "commented on the Workshop workspace" reads as vandalism. */
    inRoom?: boolean;
    link: string | null;
  },
): Promise<{ mentioned: number; followers: number }> {
  // Who a comment may reach is gated by CURRENT workspace membership: a mention
  // token can name any real uuid, so without this the high-priority DM was a
  // channel to message strangers (audit M-MENTION). recipientsFor applies the
  // filter to both tiers; orgMemberIds is the one definition of "a member".
  const [audience, members] = await Promise.all([
    audienceFor(db, {
      conversationId: args.conversationId,
      source: args.source,
      exclude: args.authorUserId,
    }),
    platform().notifications.orgMemberIds(args.orgId),
  ]);
  const { named: namedList, rest } = recipientsFor({
    mentioned: userMentions(args.body),
    audience,
    authorUserId: args.authorUserId,
    members: new Set(members),
  });
  const named = new Set(namedList);

  // A card you can answer, not just read. The action is channel-agnostic —
  // Discord renders it as a button that opens a text box, a channel that
  // cannot render actions ignores it, and the message never mentions a button
  // so it reads the same everywhere.
  //
  // `reply` is the reserved id the interactions endpoint recognises: it opens
  // a modal instead of running anything, and the modal's submission comes back
  // as the same press carrying what was typed. No gateway, and no question
  // about which workspace it belongs to, because the notification says.
  const replyAction = [
    {
      id: "reply",
      label: "Reply",
      action: "core-discussion:post-comment",
      args: {},
      style: "primary" as const,
    },
  ];

  const send = (userId: string, priority: "high" | "normal", message: string) =>
    platform()
      .notifications.dispatch({
        // The substance, for a channel that can show more than a sentence.
        // "X mentioned you in Y" tells you that something happened and not what,
        // so the only way to find out is to open the app — which is the opposite
        // of what a notification is for. Tokens are rendered to words here;
        // a raw [[user:<uuid>]] reaching somebody's chat client has happened
        // once already.
        card: {
          heading: `${args.authorName} ${args.inRoom ? "in" : "on"} ${args.recordLabel}`,
          body: excerpt(plainBody(args.body, { youUserId: userId }), 600),
        },
        actions: replyAction,
        orgId: args.orgId,
        userId,
        eventType: "core-discussion.comment.posted",
        message,
        ...(args.link ? { link_url: args.link } : {}),
        // ALL THREE come from the source triple, because together they ARE the
        // entity ref: the interactions endpoint rebuilds
        // `${module_name}:${entity_type}` and posts a Discord reply back into
        // whatever that names.
        //
        // This said "core-discussion" - the module raising the notification,
        // not the thing it is about - so the rebuilt kind was
        // `core-discussion:workspace` instead of `@workspace:workspace`, and a
        // reply typed into Discord opened a SECOND conversation for the same
        // room. It saved fine and nobody ever saw it, because every surface
        // reads the real triple. A record mention had the same fault waiting:
        // `core-discussion:part` rather than `inventory:part`, a parallel
        // conversation per record.
        module: args.source.source_module,
        entityType: args.source.source_type,
        entityId: args.source.source_id,
        priority,
      })
      // One unreachable channel must not cost the others their notification,
      // and must never fail the comment that caused it.
      .catch(() => undefined);

  await Promise.all([
    ...[...named].map((u) =>
      send(u, "high", `${args.authorName} mentioned you ${args.inRoom ? "in" : "on"} ${args.recordLabel}`),
    ),
    ...rest.map((u) =>
      send(u, "normal", `${args.authorName} said something ${args.inRoom ? "in" : "about"} ${args.recordLabel}`),
    ),
  ]);
  return { mentioned: named.size, followers: rest.length };
}
