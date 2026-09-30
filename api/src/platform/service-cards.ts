// The cards a service job sends to people (services.md section 9): a job
// waiting for a yes, a run that is stuck, anything a person is asked about one
// job. One place, so every kind of card behaves the same way:
//
//   - raising is idempotent: a person already holding a live card of this kind
//     for this job is not sent a second one, however many sweeps see the job;
//   - a card's buttons are platform actions, pressed through
//     platform().actions.invoke from the bell and from Discord alike
//     (notification-press.ts), exactly as an approval's are;
//   - settling withdraws exactly the cards it sent (marked read, so the bell
//     does not keep an answered question as a to-do), and a later raise of the
//     same kind for the same job is a new question and sends again.

import { meta } from "../db/meta.js";
import { dispatch } from "./notifications.js";

export interface JobCardAction {
  id: string;
  label: string;
  /** A platform action id (platform-actions.ts), pressed as the person. */
  action: string;
  args: Record<string, unknown>;
  style?: "primary" | "secondary" | "danger";
}

export interface JobCard {
  orgId: string;
  jobId: string;
  /** What the card is about, one word: "confirm", "stuck". */
  kind: string;
  /** Who is asked. */
  userIds: string[];
  /** The sentence for the bell and the digest. */
  message: string;
  heading: string;
  body: string;
  context?: string;
  actions: JobCardAction[];
  eventType: string;
  priority?: "low" | "normal" | "high";
}

/** Send the card to everyone in `userIds` not already holding a live one of
 *  this kind for this job. Returns who was sent one. */
export async function raiseJobCard(card: JobCard): Promise<string[]> {
  const held = await meta
    .selectFrom("service_job_cards")
    .select("user_id")
    .where("org_id", "=", card.orgId)
    .where("job_id", "=", card.jobId)
    .where("kind", "=", card.kind)
    .where("settled_at", "is", null)
    .execute();
  const already = new Set(held.map((h) => h.user_id));
  const sent: string[] = [];
  for (const userId of new Set(card.userIds)) {
    if (already.has(userId)) continue;
    // Claim the slot first, so two sweeps at once send one card.
    const claimed = await meta
      .insertInto("service_job_cards")
      .values({ org_id: card.orgId, job_id: card.jobId, kind: card.kind, user_id: userId, notification_id: null, settled_at: null })
      .onConflict((oc) =>
        oc.columns(["org_id", "job_id", "kind", "user_id"]).doUpdateSet({ settled_at: null, created_at: new Date(), notification_id: null }).where("service_job_cards.settled_at", "is not", null),
      )
      .returning("user_id")
      .executeTakeFirst();
    if (!claimed) continue;
    try {
      const r = await dispatch({
        orgId: card.orgId,
        userId,
        eventType: card.eventType,
        message: card.message,
        priority: card.priority ?? "high",
        no_link_reason: "the question is answered on the card itself, and a single job has no page of its own",
        entityType: "service_job",
        entityId: card.jobId,
        card: { heading: card.heading, body: card.body, ...(card.context ? { context: card.context } : {}) },
        actions: card.actions,
      });
      if (r.notificationId) {
        await meta
          .updateTable("service_job_cards")
          .set({ notification_id: r.notificationId })
          .where("org_id", "=", card.orgId)
          .where("job_id", "=", card.jobId)
          .where("kind", "=", card.kind)
          .where("user_id", "=", userId)
          .execute();
      }
      sent.push(userId);
    } catch (err) {
      console.warn(`[services] could not send the ${card.kind} card for ${card.jobId}: ${(err as Error).message}`);
    }
  }
  return sent;
}

/** The question is settled: every live card of this kind for this job stops
 *  asking. A kind left out settles them all. */
export async function settleJobCards(orgId: string, jobId: string, kind?: string): Promise<void> {
  let q = meta
    .updateTable("service_job_cards")
    .set({ settled_at: new Date() })
    .where("org_id", "=", orgId)
    .where("job_id", "=", jobId)
    .where("settled_at", "is", null);
  if (kind) q = q.where("kind", "=", kind);
  const rows = await q.returning("notification_id").execute();
  const ids = rows.map((r) => r.notification_id).filter((x): x is string => !!x);
  if (!ids.length) return;
  await meta
    .updateTable("notifications")
    .set({ read_at: new Date() })
    .where("id", "in", ids)
    .where("read_at", "is", null)
    .execute()
    .catch(() => {});
}
