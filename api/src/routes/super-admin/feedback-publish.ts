import { Router } from "express";
import { meta } from "../../db/meta.js";
import { callerIsAgent } from "../../platform/feedback-release.js";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import { deliverReporterReply, postResolvedCard } from "./feedback-delivery.js";

// Mounted by super-admin.ts behind requireAuth + requirePlatformAdmin.
export const feedbackPublishRouter = Router({ mergeParams: true });

// POST /super-admin/feedback/:id/publish — the owner's go for what a resolve
// held (#7460): the public "reported → fixed" card and the reporter's message.
// A person at the console only. An API token, scoped or not, is refused here
// and by the scope clamp (this path is on no scope's allowlist), so an agent
// can resolve an item but can never post publicly or message a reporter for
// the owner. Once: a second press finds nothing left to publish.
feedbackPublishRouter.post("/", async (req, res, next) => {
  try {
    if (callerIsAgent(req.session)) {
      res.status(403).json({ error: { code: "owner_only", message: "Publishing a resolved item is the owner's: sign in to the console." } });
      return;
    }
    const row = await meta
      .updateTable("feedback")
      .set({ published_at: new Date() })
      .where("id", "=", (req.params as { id: string }).id)
      .where("status", "=", "resolved")
      .where("published_at", "is", null)
      .returning([
        "id", "status", "user_id", "org_id", "message", "context", "origin", "origin_ref", "announce_message_id",
        "reachable", "contact_email", "type", "admin_notes", "triage_summary", "held_summary", "held_reply",
      ])
      .executeTakeFirst();
    if (!row) {
      res.status(409).json({ error: { code: "nothing_to_publish", message: "That item is not resolved, or was already published." } });
      return;
    }
    await postResolvedCard(row, row.held_summary);
    let sent: { notified: boolean; emailed: boolean; delivery: DeliveryOutcomes } | null = null;
    if (row.held_reply) {
      sent = await deliverReporterReply(row, {
        status: row.held_reply.status,
        reply_message: row.held_reply.message,
        public_summary: row.held_summary,
        notify_reporter: true,
      });
      await meta.updateTable("feedback").set({ held_reply: null }).where("id", "=", row.id).execute();
    }
    res.json({ id: row.id, published: true, reply_sent: !!sent?.notified, reply_delivery: sent?.delivery ?? null });
  } catch (err) {
    next(err);
  }
});
