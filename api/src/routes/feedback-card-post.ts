// The ONLY place a feedback item's Discord card is posted.
//
// A card has a lifecycle: it is edited as the item moves (feedback-card.ts).
// That needs the message id, and the id only exists if the post asked Discord
// to echo it (announceReturningMessage) AND the caller then stored it. Two
// places posted this card; one did both, one did neither, and a Discord-origin
// ticket got a second, unlinked "resolved" card hours later (2026-09-07).
//
// So posting and remembering are one function, and nothing else may post a
// `feedback.new`: announce() refuses the category at runtime, and the
// capability row in scripts/capabilities.ts refuses a second caller in CI. The
// mistake is no longer "forgot to store the id" - there is no way to post the
// card that does not store it.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { announceReturningMessage, announceRouted, type AnnouncePayload, type AnnounceResult } from "../platform/announce.js";
import { reporterCardFields } from "../platform/feedback-card.js";
import { feedbackCard } from "./feedback-card.js";

export type FeedbackCardPostResult = AnnounceResult & { skipped?: "has_card" };

/** Post and remember one card per item, across submission and late posting. Never throws. */
export async function postFeedbackCard(feedbackId: string, payload: AnnouncePayload): Promise<FeedbackCardPostResult> {
  const miss = { delivered: false, messageId: null, channelId: null };
  let claimed = false;
  try {
    if (!(await announceRouted("feedback.new", payload.originGuildId))) return miss;
    const row = await meta
      .updateTable("feedback")
      .set({ announce_message_id: CLAIM, updated_at: sql`updated_at` })
      .where("id", "=", feedbackId)
      .where("announce_message_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return { ...miss, skipped: "has_card" };
    claimed = true;
    const posted = await announceReturningMessage("feedback.new", payload);
    if (posted.messageId) {
      await meta
        .updateTable("feedback")
        .set({ announce_message_id: posted.messageId, announce_channel_id: posted.channelId, updated_at: sql`updated_at` })
        .where("id", "=", feedbackId)
        .where("announce_message_id", "=", CLAIM)
        .execute();
    }
    return posted;
  } catch (err) {
    console.error(`[feedback] card delivery or message-id capture failed for ${feedbackId}:`, err);
    return miss;
  } finally {
    if (claimed) {
      // A failed delivery gives the item back; a saved message id keeps it claimed.
      await meta
        .updateTable("feedback")
        .set({ announce_message_id: null, updated_at: sql`updated_at` })
        .where("id", "=", feedbackId)
        .where("announce_message_id", "=", CLAIM)
        .execute()
        .catch((err: unknown) => console.error(`[feedback] card claim release failed for ${feedbackId}:`, err));
    }
  }
}

/** Why a stored item's card was, or was not, posted now. */
export type LateCardResult =
  | { posted: true; messageId: string | null }
  | { posted: false; reason: "not_found" | "has_card" | "not_routed" | "not_delivered"; message: string };

const OPEN_STATUSES = ["new", "triaged", "in_progress", "awaiting_decision"] as const;

/** Post the card of an item that has none: one filed while Discord was off,
 *  or whose post failed (posting is fire-and-forget at submit). The card shows
 *  the item's stage now, the reporter's fields and screenshots, and is
 *  remembered like any other, so threads and replies work from here on.
 *
 *  One card per item: an item that has one is refused, and two callers at
 *  once cannot both post, because the first claims the row before it posts. */
export async function postCardForStoredFeedback(feedbackId: string): Promise<LateCardResult> {
  const row = await meta
    .selectFrom("feedback")
    .select(["id", "type", "status", "message", "admin_notes", "triage_summary", "origin_ref", "announce_message_id", "user_id", "org_id", "context", "attachments"])
    .where("id", "=", feedbackId)
    .executeTakeFirst();
  if (!row) return { posted: false, reason: "not_found", message: "Feedback not found." };
  if (row.announce_message_id) return { posted: false, reason: "has_card", message: "This item already has its card in Discord." };
  const originGuildId = ((row.origin_ref ?? {}) as { guild_id?: string }).guild_id ?? null;
  if (!(await announceRouted("feedback.new", originGuildId))) {
    return { posted: false, reason: "not_routed", message: "Discord is off for new feedback on this instance, so there is nowhere to post it." };
  }
  const context = (row.context ?? {}) as { route?: unknown };
  const route = typeof context.route === "string" ? context.route : "";
  const card = feedbackCard(row);
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const orgId = row.org_id;
  const posted = await postFeedbackCard(row.id, {
    title: card.title,
    body: card.body,
    color: card.color,
    fields: await reporterCardFields({ userId: row.user_id, orgId, route }),
    originGuildId,
    ...(orgId && attachments.length ? { images: attachments.map((a) => ({ orgId, fileId: a.file_id, name: a.name ?? "" })) } : {}),
  });
  if (posted.skipped) return { posted: false, reason: "has_card", message: "This item already has its card in Discord." };
  if (!posted.delivered) return { posted: false, reason: "not_delivered", message: "Discord did not take the post. Check the webhook, then try again." };
  return { posted: true, messageId: posted.messageId };
}

/** A card is being posted right now. Never a Discord id (those are digits). */
const CLAIM = "posting";

/** Post the cards of open items that have none, oldest first, at most `limit`.
 *  Runs when Discord routing for feedback is on: at boot, and the moment an
 *  admin turns it on. `onlyIds` narrows it (a test's own items). Returns how
 *  many were posted. */
export async function postCardlessFeedback(
  opts: { limit?: number; onlyIds?: string[]; onResult?: (id: string, result: LateCardResult | { posted: false; reason: "failed"; message: string }) => void } = {},
): Promise<number> {
  if (!(await announceRouted("feedback.new"))) return 0;
  let q = meta
    .selectFrom("feedback")
    .select("id")
    .where("announce_message_id", "is", null)
    .where("status", "in", [...OPEN_STATUSES])
    .orderBy("created_at", "asc")
    .limit(opts.limit ?? 20);
  if (opts.onlyIds) {
    if (!opts.onlyIds.length) return 0;
    q = q.where("id", "in", opts.onlyIds);
  }
  const rows = await q.execute();
  let n = 0;
  for (const r of rows) {
    const res = await postCardForStoredFeedback(r.id).catch((err: unknown) => {
      console.error(`[feedback] late card for ${r.id} failed:`, err);
      return null;
    });
    opts.onResult?.(r.id, res ?? { posted: false, reason: "failed", message: "The late card threw; see the api log." });
    if (res?.posted) n++;
  }
  if (n) console.log(`[feedback] posted ${n} card(s) for items filed while Discord was off`);
  return n;
}
