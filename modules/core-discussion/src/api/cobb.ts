// Cobb in the conversation.
//
// He answers INLINE, in the thread, and never hands off to his own tab. The
// reason is not convenience: the Cobb tab is PRIVATE and a conversation is
// SHARED. If he answered there, a question everybody can see would get an
// answer only one person can see, and the conversation would read, permanently,
// as a question nobody answered. A conversation's whole job is being the
// durable record of how a decision got made.
//
// WHEN HE SPEAKS
//
//   Cobb speaks only when addressed. `@cobb` addresses him, and replying to
//   Cobb addresses him.
//
// He never volunteers, never follows a conversation, never comments because
// something interesting happened. Replying re-invokes so nobody has to `@cobb`
// every turn, and that is nearly free: THE CONVERSATION IS THE SESSION. There
// is no per-conversation Cobb state, no continuation token, nothing to expire —
// every invocation reads the record plus the conversation and answers the
// newest question.
//
// ONLY HUMANS TRIGGER. The rule is a human replying to a comment authored by
// Cobb, so Cobb replying to Cobb is impossible by construction rather than by a
// guard somebody can later delete.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { fanOutComment } from "./after-comment.js";
import type { CoreDiscussionDB } from "../db.js";
import { mentionsAssistant, splitMentions } from "../mentions.js";

export const COBB_QUEUE = "core-discussion.ask-cobb";

/** Should this comment summon Cobb?
 *
 *  Pure, and exported so the rule can be tested without a queue or a model. */
export function summonsCobb(
  comment: { body: string; author_kind: "user" | "assistant"; in_reply_to: string | null },
  repliedTo: { author_kind: "user" | "assistant" } | null,
): boolean {
  // An assistant comment never triggers anything. This is the loop guard, and
  // it is structural: it does not depend on remembering to check elsewhere.
  if (comment.author_kind !== "user") return false;
  if (mentionsAssistant(comment.body)) return true;
  return repliedTo?.author_kind === "assistant";
}

/** The conversation, flattened into something a model can read.
 *
 *  Mentions are expanded to plain names, because `[[user:9f2…]]` is noise to a
 *  reader that has never seen this workspace's ids. Deleted comments are left
 *  out entirely: their text is gone, and a tombstone is not context. */
export async function transcriptFor(
  db: Kysely<CoreDiscussionDB>,
  conversationId: string,
  nameOf: (userId: string) => string,
): Promise<string> {
  const rows = await db
    .selectFrom("core_discussion_comments")
    .select(["author_kind", "author_user_id", "body", "created_at"])
    .where("conversation_id", "=", conversationId)
    .where("deleted_at", "is", null)
    .where("status", "=", "posted")
    .orderBy("created_at")
    .execute();

  return rows
    .map((r) => {
      const who = r.author_kind === "assistant" ? "Cobb" : nameOf(r.author_user_id ?? "");
      const text = splitMentions(r.body)
        .map((p) =>
          p.t === "text"
            ? p.value
            : p.t === "cobb"
              ? "@Cobb"
              : p.t === "user"
                ? `@${nameOf(p.id)}`
                : "a record",
        )
        .join("");
      return `${who}: ${text}`;
    })
    .join("\n");
}

/** Queue an answer, and put the placeholder in the conversation immediately.
 *
 *  The comment exists BEFORE its text does, which is the whole reason `status`
 *  is a column: a pending row says "Cobb is thinking", and a failed one says so
 *  out loud. Without it a failed invocation is indistinguishable from Cobb
 *  silently ignoring the question — the worst outcome, because nobody knows
 *  whether to ask again.
 *
 *  Rate-limited per conversation: several people replying to the same Cobb
 *  comment at once must not produce a storm of answers. */
export async function askCobb(
  db: Kysely<CoreDiscussionDB>,
  args: {
    orgId: string;
    conversationId: string;
    inReplyTo: string;
    requestedBy: string | null;
  },
): Promise<string | null> {
  const pending = await db
    .selectFrom("core_discussion_comments")
    .select("id")
    .where("conversation_id", "=", args.conversationId)
    .where("author_kind", "=", "assistant")
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (pending) return null;

  const placeholder = await db
    .insertInto("core_discussion_comments")
    .values({
      conversation_id: args.conversationId,
      in_reply_to: args.inReplyTo,
      author_kind: "assistant",
      author_user_id: null,
      requested_by: args.requestedBy,
      status: "pending",
      body: "",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await platform().queue.enqueue({
    orgId: args.orgId,
    queue: COBB_QUEUE,
    payload: {
      conversation_id: args.conversationId,
      comment_id: placeholder.id,
      requested_by: args.requestedBy,
    },
    maxAttempts: 1,
  });
  return placeholder.id;
}

let registered = false;

/** The worker that actually asks. */
export function registerCobbWorker(): void {
  if (registered) return;
  registered = true;

  platform().queue.registerWorker(COBB_QUEUE, async (job) => {
    const p = job.payload as {
      conversation_id?: string;
      comment_id?: string;
      requested_by?: string | null;
    };
    if (!p.conversation_id || !p.comment_id) return;
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<CoreDiscussionDB>;

    const fail = async (why: string) => {
      await db
        .updateTable("core_discussion_comments")
        .set({ status: "failed", body: why })
        .where("id", "=", p.comment_id!)
        .execute();
    };

    try {
      const conv = await db
        .selectFrom("core_discussion_conversations")
        .selectAll()
        .where("id", "=", p.conversation_id)
        .executeTakeFirst();
      if (!conv) return void (await fail("That conversation is gone."));

      const transcript = await transcriptFor(db, p.conversation_id, (id) =>
        id === p.requested_by ? "They" : "Someone",
      );

      let recordLabel = `${conv.source_module}:${conv.source_type}`;
      try {
        const r = await platform().entities.lookup(
          job.orgId,
          `${conv.source_module}:${conv.source_type}`,
          conv.source_id,
        );
        if (r?.title) recordLabel = r.title;
      } catch {
        /* the name is a nicety */
      }

      // Context is the RECORD and the CONVERSATION. Never the asker's private
      // Cobb-tab history: that tab may contain anything, and a shared thread is
      // the last place it should surface.
      const answer = await platform().ai.invoke({
        orgId: job.orgId,
        ...(p.requested_by ? { userId: p.requested_by } : {}),
        capability: "chat",
        input: {
          messages: [
            {
              role: "system",
              content:
                "You are Cobb, answering inside a shared discussion about one record in " +
                "someone's workspace. Everyone in the workspace can read your reply, so keep " +
                "it short and useful and do not repeat the question back. Answer only what " +
                "was asked. If you do not know, say so plainly.",
            },
            {
              role: "user",
              content: `The record is "${recordLabel}".\n\nThe conversation so far:\n${transcript}\n\nReply to the most recent message.`,
            },
          ],
        },
        source: { kind: "core-discussion:comment", id: p.comment_id },
      });

      const res = answer.result as { text?: string; content?: string };
      const text = (res.text ?? res.content ?? "").trim();
      if (!text) return void (await fail("Cobb had nothing to say to that."));

      await db
        .updateTable("core_discussion_comments")
        .set({ status: "posted", body: text })
        .where("id", "=", p.comment_id)
        .execute();

      // The SAME fan-out a person's comment runs. Cobb's answer used to emit
      // the event and stop, so the person who ASKED was never told the answer
      // had arrived — fine if they were still watching the panel, silence if
      // they asked and walked away. Speaking followed them to the thread, so
      // the fan-out reaches them like any other reply; author null keeps every
      // exclusion rule honest, and the name is the one they addressed.
      await fanOutComment(db, {
        orgId: job.orgId,
        conversationId: p.conversation_id,
        commentId: p.comment_id,
        body: text,
        authorUserId: null,
        authorName: "Cobb",
        source: {
          source_module: conv.source_module,
          source_type: conv.source_type,
          source_id: conv.source_id,
        },
      });
    } catch (e) {
      // A model that is not connected, a consent that was not granted, a
      // provider that fell over: all of them say so IN the conversation. A
      // silent non-answer looks like a broken feature, and the person who asked
      // has no way to tell whether to try again.
      const why = e instanceof Error ? e.message : String(e);
      await fail(
        /consent|not connected|no provider|no ai/i.test(why)
          ? "Cobb could not answer: whoever asked has no assistant connected, or has not granted it permission to read this workspace."
          : "Cobb could not answer just now.",
      );
    }
  });
}
