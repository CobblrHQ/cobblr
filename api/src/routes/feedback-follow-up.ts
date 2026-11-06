// Adding what a reporter said to their item, from every door they can say it
// through: the in-app thread, a reply to the email, a chat thread, a DM.
//
// A report that comes back to life has to read that way everywhere. Each door
// wrote the thread and the status itself, and only the chat thread also moved
// the item's Discord card, so a reporter answering "it is still broken" in the
// app left the team's channel saying resolved.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { pokeTriage } from "../platform/triage-trigger.js";
import { reflectFeedbackCard } from "./super-admin/feedback-delivery.js";

/** The columns addFollowUp needs: select these on the way in. */
export const FOLLOW_UP_COLUMNS = ["id", "status", "type", "message", "admin_notes", "triage_summary", "origin_ref", "announce_message_id"] as const;

export interface FollowUpItem {
  id: string;
  status: string | null;
  type: string | null;
  message: string | null;
  admin_notes: string | null;
  triage_summary: string | null;
  origin_ref: unknown;
  announce_message_id: string | null;
}

export async function addFollowUp(
  item: FollowUpItem,
  entry: Record<string, unknown>,
  effects: { reopen: boolean; retriage: boolean },
): Promise<void> {
  await meta
    .updateTable("feedback")
    .set({
      followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
      ...(effects.reopen ? { status: "in_progress" as never } : {}),
      ...(effects.retriage ? { triaged_at: null } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", item.id)
    .execute();
  if (effects.retriage) pokeTriage(item.id);
  if (effects.reopen) reflectFeedbackCard({ ...item, status: "in_progress" });
}
