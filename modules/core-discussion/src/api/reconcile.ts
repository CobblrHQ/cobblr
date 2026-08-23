// Keep the mention rows, and the links they justify, in step with the body.
//
// The body is the single source of truth: mentions are DERIVED from it and
// recomputed on every write, so an edit that removes "@Prusa" removes the
// mention, and — if nothing else in the conversation still names that printer —
// the link too.
//
// The rule that keeps this safe is that a mention writes its OWN relationship
// kind (MENTION_REL). Cleanup only ever removes links of that kind, so a link
// somebody created by hand between the same two records is untouched. Without
// it, editing a comment could quietly delete a user's own work, which is a far
// worse outcome than a stale link.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreDiscussionDB } from "../db.js";
import { parseMentions, MENTION_REL } from "../mentions.js";

/** The record a conversation is about, as a pairing endpoint. */
export interface RecordRef {
  kind: string;
  id: string;
}

/** Rewrite one comment's mention rows from its body, then bring the
 *  conversation's mention-made links into line.
 *
 *  Called on post, on edit and on delete — the same function every time, so the
 *  three paths cannot drift into three different ideas of what the links should
 *  be. (A delete simply passes an empty body.) */
export async function reconcileMentions(
  db: Kysely<CoreDiscussionDB>,
  args: {
    orgId: string;
    conversationId: string;
    commentId: string;
    body: string;
    /** The record being discussed — one end of every link a mention makes. */
    record: RecordRef;
    userId: string | null;
  },
): Promise<{ mentioned: number; linked: number; unlinked: number }> {
  const wanted = parseMentions(args.body);

  // What the conversation named BEFORE this write. Captured from our own table
  // rather than read back from pairings: findByTargets is scoped to a single
  // source kind, and "everything of any kind that points at this record" is not
  // a question it can ask. The diff below is exact and needs no second source
  // of truth to disagree with.
  const before = await namedEntities(db, args.conversationId);

  await db
    .deleteFrom("core_discussion_mentions")
    .where("comment_id", "=", args.commentId)
    .execute();

  if (wanted.length) {
    await db
      .insertInto("core_discussion_mentions")
      .values(
        wanted.map((m) => ({
          comment_id: args.commentId,
          kind: m.kind,
          user_id: m.kind === "user" ? m.userId : null,
          target_module: m.kind === "entity" ? m.targetModule : null,
          target_type: m.kind === "entity" ? m.targetType : null,
          target_id: m.kind === "entity" ? m.targetId : null,
        })),
      )
      .execute();
  }

  const after = await namedEntities(db, args.conversationId);

  let linked = 0;
  let unlinked = 0;

  // Newly named → link. A link is justified by ANY live comment in the
  // conversation, so two people naming the same printer make one link, and one
  // of them editing theirs does not drop it while the other still names it.
  for (const k of after) {
    if (before.has(k)) continue;
    const ref = splitRef(k);
    // Mentioning the record you are standing on is a normal way to write a
    // sentence; a self-link is just noise on the page.
    if (!ref || (ref.kind === args.record.kind && ref.id === args.record.id)) continue;
    await platform().pairings.create({
      orgId: args.orgId,
      sourceKind: ref.kind,
      sourceId: ref.id,
      targetKind: args.record.kind,
      targetId: args.record.id,
      relationshipKind: MENTION_REL,
      createdBy: args.userId,
    });
    linked++;
  }

  // No longer named → withdraw, but ONLY links of our own relationship kind.
  // A link the user made by hand between the same two records is a different
  // rel and survives.
  for (const k of before) {
    if (after.has(k)) continue;
    const ref = splitRef(k);
    if (!ref) continue;
    const { removed } = await platform().pairings.remove({
      orgId: args.orgId,
      sourceKind: ref.kind,
      sourceId: ref.id,
      targetKind: args.record.kind,
      targetId: args.record.id,
      relationshipKind: MENTION_REL,
    });
    unlinked += removed;
  }

  return { mentioned: wanted.length, linked, unlinked };
}

/** Every record this conversation currently names, as "<module>:<type>:<id>".
 *  A tombstoned comment justifies nothing — its text is gone. */
async function namedEntities(
  db: Kysely<CoreDiscussionDB>,
  conversationId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("core_discussion_mentions as m")
    .innerJoin("core_discussion_comments as c", "c.id", "m.comment_id")
    .select(["m.target_module as tm", "m.target_type as tt", "m.target_id as ti"])
    .where("c.conversation_id", "=", conversationId)
    .where("m.kind", "=", "entity")
    .where("c.deleted_at", "is", null)
    .distinct()
    .execute();
  return new Set(rows.filter((r) => r.tm && r.tt && r.ti).map((r) => `${r.tm}:${r.tt}:${r.ti}`));
}

function splitRef(key: string): { kind: string; id: string } | null {
  const [mod, type, id] = key.split(":");
  return mod && type && id ? { kind: `${mod}:${type}`, id } : null;
}
