import { Router } from "express";
import { sql } from "kysely";
import { meta } from "../../db/meta.js";
import { callerIsAgent } from "../../platform/feedback-release.js";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import { deliverReporterReply, postResolvedCard, type ReleaseRow } from "./feedback-delivery.js";

// Mounted by super-admin.ts behind requireAuth + requirePlatformAdmin.
export const feedbackPublishRouter = Router({ mergeParams: true });

// POST /super-admin/feedback/:id/publish — the owner's go for what was held
// (#7460): the public "reported → fixed" card of a resolved item, and whatever
// reply waits for the reporter, on an item in any state. The reply goes out for
// what the item is now: a question on an open item is a question, and a held
// "fixed" on an item the reporter has since reopened no longer says it is live.
// A person at the console only. An API token, scoped or not, is refused here
// and by the scope clamp (this path is on no scope's allowlist), so an agent
// can resolve an item but can never post publicly or message a reporter for
// the owner. Once: the claim below empties what is held, so a second press finds
// nothing left to publish.
// REPLAY: once: the claim empties what is held, so a repeat finds nothing to publish
feedbackPublishRouter.post("/", async (req, res, next) => {
  try {
    if (callerIsAgent(req.session)) {
      res.status(403).json({ error: { code: "owner_only", message: "Publishing a resolved item is the owner's: sign in to the console." } });
      return;
    }
    const id = (req.params as { id: string }).id;
    const claimed = await sql<ReleaseRow & { held_summary: string | null; held_reply: { message: string | null } | null; card_due: boolean }>`
      update feedback f
         set published_at = case when was.card_due then now() else f.published_at end, held_reply = null
        from (
          select id, held_reply, status = 'resolved' and published_at is null as card_due
            from feedback
           where id = ${id} and ((status = 'resolved' and published_at is null) or held_reply is not null)
             for update
        ) was
       where f.id = was.id
   returning f.id, f.status, f.user_id, f.org_id, f.message, f.context, f.origin, f.origin_ref, f.announce_message_id,
             f.reachable, f.contact_email, f.type, f.admin_notes, f.triage_summary, f.held_summary, was.held_reply, was.card_due
    `.execute(meta);
    const row = claimed.rows[0];
    if (!row) {
      res.status(409).json({ error: { code: "nothing_to_publish", message: "Nothing on that item is waiting to be published." } });
      return;
    }
    if (row.card_due) await postResolvedCard(row, row.held_summary);
    let sent: { notified: boolean; emailed: boolean; delivery: DeliveryOutcomes } | null = null;
    if (row.held_reply) {
      sent = await deliverReporterReply(row, {
        status: row.status,
        reply_message: row.held_reply.message,
        public_summary: row.held_summary,
        notify_reporter: true,
      }).catch(async (err: unknown) => {
        await meta.updateTable("feedback").set({ held_reply: sql`${JSON.stringify(row.held_reply)}::jsonb` }).where("id", "=", row.id).execute();
        throw err;
      });
    }
    res.json({ id: row.id, published: true, reply_sent: !!sent?.notified, reply_delivery: sent?.delivery ?? null });
  } catch (err) {
    next(err);
  }
});
