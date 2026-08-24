// One conversation per record, flat and chronological.
//
// Spec: docs/design-decisions/discussion-and-the-side-rail.md

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { reconcileMentions } from "./reconcile.js";
import { followRecord, notifyAboutComment } from "./audience.js";
import { askCobb, summonsCobb } from "./cobb.js";
import { userMentions } from "../mentions.js";
import { isWorkspaceRoom } from "@cobblr/platform-contract/workspace-room";

export const discussionRouter = Router({ mergeParams: true });

const Source = z.object({
  source_module: z.string().min(1).max(64),
  source_type: z.string().min(1).max(120),
  source_id: z.string().uuid(),
});

/** Longest a comment may be. Long enough for a considered paragraph, short
 *  enough that the table cannot become a document store by accident. */
const BODY_MAX = 10_000;

const PostBody = Source.extend({
  body: z.string().min(1).max(BODY_MAX),
  in_reply_to: z.string().uuid().nullish(),
});

/** Normalise a source triple's kind halves to the BASE kind.
 *
 *  The triple splits a kind into module + short type ("inventory" + "part"),
 *  but `baseKindOf` speaks whole kinds ("inventory:part"). Passing it the short
 *  half is not a no-op — it is an unregistered kind, so it comes back unchanged
 *  and the two spellings of the SAME record normalise differently. That is how
 *  the first version of this opened one conversation for `source_type=part` and
 *  a second, empty one for `source_type=inventory:part`, on the same printer.
 *  (Caught by the test that asks both ways, which is why it exists.)
 *
 *  So: join, resolve, split back. An instance kind ("kitchen-stuff:item")
 *  resolves to its owning module's kind, and BOTH halves move with it — an
 *  instance is a partition of the same table, not a different entity. */
async function normaliseSource(
  orgId: string,
  src: { source_module: string; source_type: string },
): Promise<{ source_module: string; source_type: string }> {
  const whole = src.source_type.includes(":")
    ? src.source_type
    : `${src.source_module}:${src.source_type}`;
  let base = whole;
  try {
    base = await platform().entities.baseKindOf(orgId, whole);
  } catch {
    // An unregistered kind is still discussable — a polymorphic side-car does
    // not ask permission. Fall back to what was given.
  }
  const [mod, type] = base.split(":");
  return mod && type ? { source_module: mod, source_type: type } : src;
}

/** The conversation for a record, created on demand.
 *
 *  `on conflict do nothing` + re-read rather than a read-then-insert: two
 *  people commenting on a fresh record at the same moment would otherwise both
 *  see "no conversation" and both insert, and the unique constraint would turn
 *  one of their comments into a 500. */
async function ensureConversation(
  db: ReturnType<typeof tenantDb>,
  src: { source_module: string; source_type: string; source_id: string },
): Promise<string> {
  const existing = await db
    .selectFrom("core_discussion_conversations")
    .select("id")
    .where("source_module", "=", src.source_module)
    .where("source_type", "=", src.source_type)
    .where("source_id", "=", src.source_id)
    .executeTakeFirst();
  if (existing) return existing.id;

  const inserted = await db
    .insertInto("core_discussion_conversations")
    .values(src)
    .onConflict((oc) => oc.columns(["source_module", "source_type", "source_id"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;

  // Lost the race: the other insert won, so read theirs.
  const winner = await db
    .selectFrom("core_discussion_conversations")
    .select("id")
    .where("source_module", "=", src.source_module)
    .where("source_type", "=", src.source_type)
    .where("source_id", "=", src.source_id)
    .executeTakeFirstOrThrow();
  return winner.id;
}

interface CommentRow {
  id: string;
  in_reply_to: string | null;
  author_kind: "user" | "assistant";
  author_user_id: string | null;
  requested_by: string | null;
  status: "posted" | "pending" | "failed";
  body: string;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

/** A comment as it goes over the wire.
 *
 *  Author is an ID, never a name. These are TENANT tables and users live in
 *  cobblr_meta — a different database, so there is no join to make and no
 *  foreign key to declare. The web resolves ids against the member list it
 *  already fetches; storing a display name here would be wrong the moment
 *  somebody is renamed. (The spec said "resolve at the API layer"; the platform
 *  exposes no member lookup to a module, and inventing one to avoid a lookup
 *  the web already does would be the wrong trade.) */
function forWire(rows: CommentRow[]) {
  return rows.map((r) => ({
    ...r,
    // The body of a deleted comment is gone; the row survives only so a reply
    // quoting it can say so.
    body: r.deleted_at ? "" : r.body,
  }));
}

// GET /?source_module=&source_type=&source_id= — a record's conversation.
discussionRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = Source.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const src = await normaliseSource(ctx.org.id, parsed.data);

    const conv = await db
      .selectFrom("core_discussion_conversations")
      .selectAll()
      .where("source_module", "=", src.source_module)
      .where("source_type", "=", src.source_type)
      .where("source_id", "=", parsed.data.source_id)
      .executeTakeFirst();

    if (!conv) {
      res.json({ conversation: null, comments: [], count: 0 });
      return;
    }

    const rows = (await db
      .selectFrom("core_discussion_comments")
      .select([
        "id",
        "in_reply_to",
        "author_kind",
        "author_user_id",
        "requested_by",
        "status",
        "body",
        "edited_at",
        "deleted_at",
        "created_at",
      ])
      .where("conversation_id", "=", conv.id)
      .orderBy("created_at")
      .execute()) as CommentRow[];

    res.json({
      conversation: conv,
      comments: forWire(rows),
      // Deleted comments are tombstones, not content: they must not inflate the
      // count on the record's inline preview.
      count: rows.filter((r) => !r.deleted_at).length,
    });
  }),
);

// POST / — say something. Creates the conversation on first comment.
// AI-REACH: action core-discussion:post-comment
discussionRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    const db = tenantDb(req);
    const src = await normaliseSource(ctx.org.id, parsed.data);

    const conversationId = await ensureConversation(db, {
      ...src,
      source_id: parsed.data.source_id,
    });

    // A notification that says "commented on machines:machine" is the machine's
    // version of the answer. Resolve the record's name; fall back to the kind
    // rather than failing the comment if the resolver cannot.
    // The ROOM is not a record, so there is nothing to look up and the kind is
    // a sentinel. Left to the fallback below it produced, in a real Discord DM:
    //
    //   "Sam mentioned you on @workspace:workspace"
    //
    // The workspace's own name is the answer, and it is already in hand.
    const room = isWorkspaceRoom(src);
    let recordTitle = room
      ? ctx.org.name || "your workspace"
      : `${src.source_module}:${src.source_type}`;
    try {
      if (room) throw new Error("skip lookup");
      const resolved = await platform().entities.lookup(
        ctx.org.id,
        `${src.source_module}:${src.source_type}`,
        parsed.data.source_id,
      );
      if (resolved?.title) recordTitle = resolved.title;
    } catch {
      /* the name is a nicety; the notification still has to go */
    }

    const comment = await db
      .insertInto("core_discussion_comments")
      .values({
        conversation_id: conversationId,
        in_reply_to: parsed.data.in_reply_to ?? null,
        author_kind: "user",
        author_user_id: user?.id ?? null,
        body: parsed.data.body,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await reconcileMentions(db, {
      orgId: ctx.org.id,
      conversationId,
      commentId: comment.id,
      body: parsed.data.body,
      record: { kind: `${src.source_module}:${src.source_type}`, id: parsed.data.source_id },
      userId: user?.id ?? null,
    });

    // Posting into a settled conversation opens it again: a resolve is a
    // bookmark meaning "decided", never a lock.
    await db
      .updateTable("core_discussion_conversations")
      .set({ updated_at: new Date(), resolved_at: null, resolved_by: null })
      .where("id", "=", conversationId)
      .execute();

    // Speaking is following. You are then told when somebody answers, which is
    // the whole reason to say anything in a shared place.
    if (user?.id) {
      await followRecord(db, {
        source: { ...src, source_id: parsed.data.source_id },
        userId: user.id,
        reason: "commented",
      });
    }
    // Being NAMED also follows: you were pulled in, so you should hear the
    // reply without having to remember to come back.
    for (const named of userMentions(parsed.data.body)) {
      await followRecord(db, {
        source: { ...src, source_id: parsed.data.source_id },
        userId: named,
        reason: "mentioned",
      });
    }

    await notifyAboutComment(db, {
      orgId: ctx.org.id,
      conversationId,
      source: { ...src, source_id: parsed.data.source_id },
      body: parsed.data.body,
      authorUserId: user?.id ?? null,
      authorName: user?.display_name || "Somebody",
      recordLabel: recordTitle,
      // "mentioned you ON the blue widget" but "IN the workspace": a room is
      // somewhere you are, a record is something you are looking at.
      inRoom: room,
      link: null,
    });

    // Cobb, if he was addressed. Either by name, or by replying to something he
    // said — which is what lets a back-and-forth continue without typing @cobb
    // every turn.
    const repliedTo = parsed.data.in_reply_to
      ? ((await db
          .selectFrom("core_discussion_comments")
          .select("author_kind")
          .where("id", "=", parsed.data.in_reply_to)
          .executeTakeFirst()) ?? null)
      : null;
    if (
      summonsCobb(
        { body: parsed.data.body, author_kind: "user", in_reply_to: parsed.data.in_reply_to ?? null },
        repliedTo,
      )
    ) {
      // Under the REPLIER's identity, never the person who first asked: Cobb
      // reads records under their consent and their connection, and answering
      // one person's question with another's permissions is a real leak.
      await askCobb(db, {
        orgId: ctx.org.id,
        conversationId,
        inReplyTo: comment.id,
        requestedBy: user?.id ?? null,
      });
    }

    await platform().events.emit("core-discussion.comment.posted", {
      orgId: ctx.org.id,
      conversation_id: conversationId,
      comment_id: comment.id,
      ...src,
      source_id: parsed.data.source_id,
      author_user_id: user?.id ?? null,
    });

    res.status(201).json({ comment });
  }),
);

/** The conversation a comment belongs to, and the record it is about — what
 *  reconcile needs and what a comment id alone does not carry. */
async function contextOf(db: ReturnType<typeof tenantDb>, commentId: string) {
  return db
    .selectFrom("core_discussion_comments as c")
    .innerJoin("core_discussion_conversations as v", "v.id", "c.conversation_id")
    .select([
      "c.id as comment_id",
      "v.id as conversation_id",
      "v.source_module as source_module",
      "v.source_type as source_type",
      "v.source_id as source_id",
    ])
    .where("c.id", "=", commentId)
    .executeTakeFirst();
}

const EditBody = z.object({ body: z.string().min(1).max(BODY_MAX) });

// PATCH /:id — edit your own words.
// AI-REACH: exempt — editing the record of what a person said is theirs to do,
// not an assistant's. Cobb posts new comments instead of rewriting old ones.
discussionRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = EditBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const user = sessionUser(req);
    const db = tenantDb(req);
    const id = req.params.id;

    const existing = await db
      .selectFrom("core_discussion_comments")
      .select(["id", "author_user_id", "deleted_at"])
      .where("id", "=", id!)
      .executeTakeFirst();
    if (!existing || existing.deleted_at) {
      res.status(404).json({ error: { code: "not_found", message: "No such comment." } });
      return;
    }
    // Only your own. An admin may DELETE anyone's (moderation) but may not
    // rewrite what someone said.
    if (existing.author_user_id !== user?.id) {
      res.status(403).json({ error: { code: "not_yours", message: "You can only edit your own comments." } });
      return;
    }

    const updated = await db
      .updateTable("core_discussion_comments")
      .set({ body: parsed.data.body, edited_at: new Date() })
      .where("id", "=", id!)
      .returningAll()
      .executeTakeFirstOrThrow();

    // The body is the source of truth, so an edit that drops a mention drops
    // the link it justified — unless another comment still names the same
    // record. Same function as post and delete, so the three cannot disagree.
    const where = await contextOf(db, id!);
    if (where) {
      await reconcileMentions(db, {
        orgId: tenantContext(req).org.id,
        conversationId: where.conversation_id,
        commentId: id!,
        body: parsed.data.body,
        record: { kind: `${where.source_module}:${where.source_type}`, id: where.source_id },
        userId: user?.id ?? null,
      });
    }
    res.json({ comment: updated });
  }),
);

// DELETE /:id — a tombstone, never a hard delete.
// AI-REACH: exempt — deleting a person's words is theirs or a moderator's to
// do; there is deliberately no assistant path to it.
discussionRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    const db = tenantDb(req);
    const id = req.params.id;

    const existing = await db
      .selectFrom("core_discussion_comments")
      .select(["id", "author_user_id"])
      .where("id", "=", id!)
      .executeTakeFirst();
    if (!existing) {
      res.status(404).json({ error: { code: "not_found", message: "No such comment." } });
      return;
    }
    const isOwn = existing.author_user_id === user?.id;
    const isModerator = ctx.role === "owner" || ctx.role === "admin";
    if (!isOwn && !isModerator) {
      res.status(403).json({ error: { code: "not_yours", message: "You can only delete your own comments." } });
      return;
    }

    // The row stays so a reply quoting it can still say "message removed"; the
    // body is cleared so the text is genuinely gone.
    const where = await contextOf(db, id!);

    // RECONCILE FIRST, then tombstone. Order is load-bearing here and nowhere
    // else: reconcile diffs what the conversation named BEFORE against AFTER,
    // and it counts only comments that are not deleted. Tombstoning first makes
    // the "before" snapshot already exclude this comment's mentions, so the
    // diff comes out empty and the links it justified are never withdrawn.
    // (Post and patch change BODIES, and the snapshot reads mention rows, so
    // they are unaffected either way.) Caught by the hand-made-link test, which
    // failed on the half it was not written to check.
    if (where) {
      await reconcileMentions(db, {
        orgId: ctx.org.id,
        conversationId: where.conversation_id,
        commentId: id!,
        body: "",
        record: { kind: `${where.source_module}:${where.source_type}`, id: where.source_id },
        userId: user?.id ?? null,
      });
    }

    await db
      .updateTable("core_discussion_comments")
      .set({ deleted_at: new Date(), deleted_by: user?.id ?? null, body: "" })
      .where("id", "=", id!)
      .execute();
    res.status(204).end();
  }),
);

const ResolveBody = z.object({ resolved: z.boolean() });

// POST /:id/resolve — settle a conversation, or open it again.
// AI-REACH: action core-discussion:resolve-conversation
discussionRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    const db = tenantDb(req);
    const id = req.params.id;

    const conv = await db
      .updateTable("core_discussion_conversations")
      .set(
        parsed.data.resolved
          ? { resolved_at: new Date(), resolved_by: user?.id ?? null, updated_at: new Date() }
          : { resolved_at: null, resolved_by: null, updated_at: new Date() },
      )
      .where("id", "=", id!)
      .returningAll()
      .executeTakeFirst();
    if (!conv) {
      res.status(404).json({ error: { code: "not_found", message: "No such conversation." } });
      return;
    }
    if (parsed.data.resolved) {
      await platform().events.emit("core-discussion.conversation.resolved", {
        orgId: ctx.org.id,
        conversation_id: conv.id,
        resolved_by: user?.id ?? null,
      });
    }
    res.json({ conversation: conv });
  }),
);

// ── read state, following, and the one place that answers "what is new" ──────

const FollowBody = Source.extend({ following: z.boolean() });

// POST /follow — start or stop following a record.
// AI-REACH: exempt — whose attention goes where is a person's own setting, not
// something an assistant should be arranging on their behalf.
discussionRouter.post(
  "/follow",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = FollowBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    if (!user) {
      res.status(401).json({ error: { code: "no_session", message: "sign in first" } });
      return;
    }
    const db = tenantDb(req);
    const src = await normaliseSource(ctx.org.id, parsed.data);
    const where = { ...src, source_id: parsed.data.source_id };

    if (parsed.data.following) {
      // An EXPLICIT follow outranks an implicit one, so re-following something
      // you already comment on is not a no-op — it survives any future rule
      // that prunes implicit follows.
      await db
        .insertInto("core_discussion_follows")
        .values({ ...where, user_id: user.id, reason: "explicit" })
        .onConflict((oc) =>
          oc
            .columns(["source_module", "source_type", "source_id", "user_id"])
            .doUpdateSet({ reason: "explicit" }),
        )
        .execute();
    } else {
      await db
        .deleteFrom("core_discussion_follows")
        .where("source_module", "=", where.source_module)
        .where("source_type", "=", where.source_type)
        .where("source_id", "=", where.source_id)
        .where("user_id", "=", user.id)
        .execute();
    }
    res.json({ following: parsed.data.following });
  }),
);

// POST /read — mark this record's conversation as read up to now.
// AI-REACH: exempt — "I have read this" is a claim only the reader can make.
discussionRouter.post(
  "/read",
  asyncHandler(async (req, res) => {
    const parsed = Source.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const user = sessionUser(req);
    if (!user) {
      res.status(401).json({ error: { code: "no_session", message: "sign in first" } });
      return;
    }
    const db = tenantDb(req);
    const src = await normaliseSource(ctx.org.id, parsed.data);
    const conv = await db
      .selectFrom("core_discussion_conversations")
      .select("id")
      .where("source_module", "=", src.source_module)
      .where("source_type", "=", src.source_type)
      .where("source_id", "=", parsed.data.source_id)
      .executeTakeFirst();
    // Nothing said yet is nothing to mark read; not an error.
    if (!conv) {
      res.status(204).end();
      return;
    }
    await db
      .insertInto("core_discussion_reads")
      .values({ conversation_id: conv.id, user_id: user.id, last_read_at: new Date() })
      .onConflict((oc) =>
        oc.columns(["conversation_id", "user_id"]).doUpdateSet({ last_read_at: new Date() }),
      )
      .execute();
    res.status(204).end();
  }),
);

// GET /inbox — everything with something new in it, for me.
//
// One place to answer everything, instead of remembering which records to go
// back and reopen. "New" is per-user: a conversation is unread when its newest
// comment is newer than your last read of it, and one you have never opened
// counts as unread rather than as read-by-default.
discussionRouter.get(
  "/inbox",
  asyncHandler(async (req, res) => {
    const user = sessionUser(req);
    if (!user) {
      res.status(401).json({ error: { code: "no_session", message: "sign in first" } });
      return;
    }
    const db = tenantDb(req);
    // `?q=` searches what was SAID, across every conversation you can see.
    //
    // Deliberately here and not in global search: core-search works off
    // registered entity KINDS, and making every comment one would put comments
    // in kind pickers, wire targets and the global palette — a platform-wide
    // shape change to serve a question people ask from this page. Scoped search
    // is the honest 90%; the doc records what the other 10% would cost.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rows = await db
      .selectFrom("core_discussion_conversations as v")
      .innerJoin("core_discussion_comments as c", "c.conversation_id", "v.id")
      .leftJoin("core_discussion_reads as r", (j) =>
        j.onRef("r.conversation_id", "=", "v.id").on("r.user_id", "=", user.id),
      )
      .leftJoin("core_discussion_follows as f", (j) =>
        j
          .onRef("f.source_module", "=", "v.source_module")
          .onRef("f.source_type", "=", "v.source_type")
          .onRef("f.source_id", "=", "v.source_id")
          .on("f.user_id", "=", user.id),
      )
      .select(({ fn }) => [
        "v.id as conversation_id",
        "v.source_module as source_module",
        "v.source_type as source_type",
        "v.source_id as source_id",
        "v.resolved_at as resolved_at",
        "f.reason as follow_reason",
        "r.last_read_at as last_read_at",
        fn.max("c.created_at").as("latest_at"),
        fn.count<number>("c.id").as("comments"),
      ])
      .where("c.deleted_at", "is", null)
      .$if(q.length > 0, (qb) => qb.where("c.body", "ilike", `%${q}%`))
      .groupBy([
        "v.id",
        "v.source_module",
        "v.source_type",
        "v.source_id",
        "v.resolved_at",
        "f.reason",
        "r.last_read_at",
      ])
      .orderBy("latest_at", "desc")
      .limit(200)
      .execute();

    // Which of these NAME me. Done as one read rather than per row: an inbox
    // that costs a query per conversation is one that gets slow exactly as it
    // becomes useful.
    const mentioned = new Set(
      (
        await db
          .selectFrom("core_discussion_mentions as m")
          .innerJoin("core_discussion_comments as c", "c.id", "m.comment_id")
          .select("c.conversation_id as conversation_id")
          .where("m.kind", "=", "user")
          .where("m.user_id", "=", user.id)
          .where("c.deleted_at", "is", null)
          .distinct()
          .execute()
      ).map((r) => r.conversation_id),
    );

    const items = rows.map((r) => {
      const latest = r.latest_at ? new Date(r.latest_at as unknown as string) : null;
      const read = r.last_read_at ? new Date(r.last_read_at as unknown as string) : null;
      return {
        conversation_id: r.conversation_id,
        source_module: r.source_module,
        source_type: r.source_type,
        source_id: r.source_id,
        resolved_at: r.resolved_at,
        comments: Number(r.comments ?? 0),
        latest_at: latest,
        // Never opened counts as unread: a conversation you have not seen is
        // exactly the thing an inbox exists to show you.
        unread: !!latest && (!read || latest > read),
        addressed_to_me: mentioned.has(r.conversation_id),
        following: !!r.follow_reason,
        follow_reason: r.follow_reason ?? null,
      };
    });
    res.json({ items });
  }),
);
