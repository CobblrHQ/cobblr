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
import { announceReturningMessage, type AnnouncePayload, type AnnounceResult } from "../platform/announce.js";

/** Post the item's card and remember which message it is. Never throws. */
export async function postFeedbackCard(feedbackId: string, payload: AnnouncePayload): Promise<AnnounceResult> {
  const posted = await announceReturningMessage("feedback.new", payload);
  if (posted.messageId) {
    try {
      await meta
        .updateTable("feedback")
        .set({ announce_message_id: posted.messageId, announce_channel_id: posted.channelId, updated_at: sql`updated_at` })
        .where("id", "=", feedbackId)
        .execute();
    } catch (err) {
      // The card exists but we cannot find it again: say so loudly, because
      // every later edit will silently fall back to a second card.
      console.error(`[feedback] card posted for ${feedbackId} but its id could not be stored:`, err);
    }
  }
  return posted;
}
