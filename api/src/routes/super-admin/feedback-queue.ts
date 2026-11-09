// Working the feedback queue: moving an item, closing several at once, the close
// button in a chat thread, and a reporter's screenshot. Moved out of
// super-admin.ts, which is over the route-file size cap and only mounts new
// groups (#7385). Mounted behind requireAuth + requirePlatformAdmin.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";
import { optionalText } from "@cobblr/platform-contract/optional-fields";
import { meta } from "../../db/meta.js";
import { pokeDiscordFeedbackStage, pokeDiscordResolved, type FeedbackStage } from "../../platform/discord-bot-trigger.js";
import { escHtml } from "../../platform/esc-html.js";
import { reporterIsOperator } from "../../platform/feedback-owner.js";
import { callerIsAgent, resolveMayReplyNow, summaryToHold } from "../../platform/feedback-release.js";
import { feedbackReplyAddress } from "../../platform/feedback-reply.js";
import { feedbackReplyText } from "../../platform/feedback-reply-text.js";
import { emailableUrl } from "../../platform/link-origin.js";
import { notifyAccount } from "../../platform/notifications.js";
import { productName } from "../../platform/product-name.js";
import { deliverReporterReply, reflectFeedbackCard } from "./feedback-delivery.js";
import { replayAccountWrite } from "../../platform/request-replays.js";

export const feedbackQueueRouter = Router();

// The same short list core-files serves inline. Anything else a reporter attached
// downloads, because a stored type is whatever the upload claimed and an SVG
// opened from this origin runs its script with the console's session.
const SHOWN_INLINE = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

const UpdateFeedback = z.object({
  // Status lanes:
  //  - `awaiting_decision` = the autopilot posted a spec/question card and is
  //    waiting on the author to choose (Build/Pursue/Pass/Backlog). OPEN + ACTIONABLE —
  //    it stays in the working queue so it can't silently vanish; the autopilot
  //    skips it (won't re-analyze / re-card). This is where "Analyze" items land
  //    instead of `backlog`.
  //  - `backlog` = parked for a human to handle interactively later: OPEN (not
  //    dismissed like wontfix), but the autopilot + triage skip it. The
  //    "keep for human, don't resurface" lane — ONLY the explicit 📥 Backlog
  //    button (or a human) puts an item here, never the autopilot by default.
  // Actionable set = new / triaged / in_progress / awaiting_decision.
  status: z
    .enum(["new", "triaged", "in_progress", "awaiting_decision", "backlog", "resolved", "wontfix"])
    .optional(),
  admin_notes: z.string().max(5000).nullable().optional(),
  // When true, send the reporter an in-app notification (a "we looked at
  // this" / "it's fixed" reply). `reply_message` is the human note; falls
  // back to a status-derived default. Best-effort — never fails the update.
  notify_reporter: z.boolean().optional(),
  reply_message: optionalText(2000),
  // Third-person "what was reported → what we fixed" note for the PUBLIC Discord
  // feedback-resolved post (NOT addressed to the reporter). Distinct from
  // reply_message (the personal in-app/email reply). Used when status=resolved.
  public_summary: optionalText(2000),
  // AI triage verdict, written by the host-side analyzer (feedback:triage
  // token). Setting this stamps triaged_at; the analyzer also passes
  // status:"triaged". Kept a nested object so a human PATCH (status/notes)
  // and a machine PATCH (verdict) don't step on each other's shapes.
  triage: z
    .object({
      priority: z.enum(["urgent", "high", "medium", "low"]),
      valid: z.boolean(),
      viable: z.boolean(),
      summary: z.string().max(4000),
      action: z.string().max(2000),
      model: z.string().max(80).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
      // The analyzer may RE-FILE the item. A ticket arrives typed by the channel
      // it was posted in, which is a guess made before anybody read it: a bug
      // reported in #help arrives as "other", and a use case that turns out to
      // be a real gap should become an idea. Content beats channel, so whoever
      // read the words gets to correct it.
      //
      // Nested here rather than top-level BECAUSE of the scope: a feedback:triage
      // token may write `triage` and `status` and nothing else, and a top-level
      // `type` would widen what that narrow credential can reach.
      type: z.enum(["bug", "confusing", "idea", "use_case", "other"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
    })
    .optional(),
});

// Map a feedback row's status + admin_notes to its lifecycle stage, for the
// Discord reaction trail. Terminal states win; otherwise the autopilot's
// in-flight markers, most-advanced first (PR up > building > grabbed). Returns
// null for a plain new/triaged item with no marker (nothing to react yet).
function feedbackStage(row: { status: string | null; admin_notes: string | null }): FeedbackStage | null {
  const notes = row.admin_notes ?? "";
  if (row.status === "resolved") return "shipped";
  if (row.status === "wontfix") return "passed";
  if (row.status === "awaiting_decision") return "spec";
  if (/autopilot PR #/i.test(notes)) return "pr_open";
  if (notes.includes("🔨 BUILD REQUESTED")) return "building";
  if (/🔒 CLAIMED by /.test(notes)) return "grabbed";
  return null;
}

// POST /super-admin/feedback/resolve-by-thread — the reporter clicked the Discord
// support bot's "✅ That solved it — close" button. Resolve the matching ticket.
// Lean on purpose: NO "what we did" line and NO bot re-poke (the bot already
// archived the thread on the click); the item's own card still follows its state.
// Gated by the same feedback:ingest scope the bot already holds.
const ResolveByThread = z.object({ thread_id: z.string().min(1), by: z.string().max(120).optional() });
// UI-REACH: the support bot closing a ticket from its thread
feedbackQueueRouter.post("/resolve-by-thread", replayAccountWrite, async (req, res, next) => {
  try {
    const parsed = ResolveByThread.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "type", "message", "admin_notes", "triage_summary", "origin_ref", "announce_message_id", "announce_channel_id"])
      .where(sql`origin_ref ->> 'thread_id'`, "=", parsed.data.thread_id)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "not_found", message: "No ticket for that thread." } });
      return;
    }
    await meta
      .updateTable("feedback")
      .set({
        status: "resolved" as never,
        admin_notes: sql`coalesce(admin_notes, '') || ${`\n[closed via Discord button by ${parsed.data.by ?? "user"}]`}`,
        updated_at: new Date(),
      })
      .where("id", "=", fb.id)
      .execute();
    reflectFeedbackCard({ ...fb, status: "resolved" });
    pokeDiscordFeedbackStage({ feedback_id: fb.id, stage: "shipped", message_id: fb.announce_message_id, channel_id: fb.announce_channel_id });
    res.json({ id: fb.id, status: "resolved" });
  } catch (err) {
    next(err);
  }
});

// PATCH /super-admin/feedback/:id — set status / admin notes during triage.
feedbackQueueRouter.patch("/:id", async (req, res, next) => {
  try {
    const parsed = UpdateFeedback.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.admin_notes !== undefined) patch.admin_notes = parsed.data.admin_notes;
    if (parsed.data.triage) {
      const t = parsed.data.triage;
      patch.triage_priority = t.priority;
      patch.triage_valid = t.valid;
      patch.triage_viable = t.viable;
      patch.triage_summary = t.summary;
      patch.triage_action = t.action;
      patch.triage_model = t.model ?? null;
      patch.triaged_at = new Date();
      // Only when the analyzer actually offered one. Absent means "leave the
      // channel's guess alone", never "reset it to a default".
      if (t.type !== undefined) patch.type = t.type;
    }
    const row = await meta
      .updateTable("feedback")
      .set(patch)
      .where("id", "=", req.params.id)
      .returning([
        "id",
        "status",
        "admin_notes",
        "updated_at",
        "user_id",
        "org_id",
        "message",
        "context",
        "origin",
        "origin_ref",
        "announce_message_id",
        "announce_channel_id",
        "reachable",
        "contact_email",
        "type",
        "triage_summary",
      ])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }
    // The item's ONE card follows its state. A resolve carries the "what we
    // did" line and is handled below (it needs the reporter fields); everything
    // else is reflected here, on every transition through this handler.
    if (parsed.data.status !== undefined && parsed.data.status !== "resolved") reflectFeedbackCard(row);

    // Reflect the item's new lifecycle stage back onto Discord as an emoji
    // reaction — on the public #feedback post (if tracked) and on the private
    // autopilot card. Fires on every transition that flows through this handler:
    // the autopilot's claim (🔒 → grabbed), a 🔨 Build request, a PR-open note,
    // awaiting_decision (spec), resolve (shipped), wontfix (passed). Add-only +
    // idempotent, so re-poking the same stage is harmless.
    const stage = feedbackStage(row);
    if (stage) {
      pokeDiscordFeedbackStage({
        feedback_id: row.id,
        stage,
        message_id: row.announce_message_id,
        channel_id: row.announce_channel_id,
      });
    }

    // Resolving never publishes (#7460). The public line is stored for the
    // owner to publish; the reporter's message is sent now only by a person at
    // the console or for the owner's own ticket, and otherwise held beside it.
    const agent = callerIsAgent(req.session);
    const wantsReply = !!parsed.data.notify_reporter;
    const replyNow = wantsReply && resolveMayReplyNow({ callerIsAgent: agent, reporterIsOperator: agent ? await reporterIsOperator(row) : true });
    const held = { summary: false, reply: false };
    if (parsed.data.status === "resolved") {
      const summary = summaryToHold(parsed.data);
      if (summary) {
        await meta.updateTable("feedback").set({ held_summary: summary, published_at: null }).where("id", "=", row.id).execute();
        held.summary = true;
      }
      // The item's card follows its state; the "what we did" line waits for publish.
      reflectFeedbackCard(row);
    }
    if (wantsReply && !replyNow) {
      await meta
        .updateTable("feedback")
        .set({ held_reply: sql`${JSON.stringify({ message: parsed.data.reply_message?.trim() || null, status: row.status })}::jsonb` })
        .where("id", "=", row.id)
        .execute();
      held.reply = true;
    }
    const sent = replyNow
      ? await deliverReporterReply(row, parsed.data)
      : { notified: false, emailed: false, delivery: {} as DeliveryOutcomes };
    const { notified, emailed, delivery } = sent;

    res.json({ ...row, notified, emailed, reply_delivery: delivery, held });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/batch-resolve — close several items at once with
// ONE reporter-facing email/notification per reporter. Each item still resolves
// individually (its own status + its own public changelog entry); the reporter
// just isn't pinged N times. This is the proper form of "fix these three and
// email the person once" — vs. faking it with a single "carrier" item, which
// mis-quoted the original report and doubled the greeting.
//
// `reply_message` is the ONE combined body — do NOT include a greeting; the
// email prepends "Hi <name>,". The public changelog only re-posts on a genuine
// resolve TRANSITION, so re-running this on already-resolved items (e.g. to
// re-send a corrected email) emails without duplicating changelog entries.
const BatchResolveBody = z.object({
  status: z.enum(["resolved", "wontfix"]).nullish().transform((v) => v ?? "resolved"),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        // Third-person changelog line for the PUBLIC Discord post.
        public_summary: optionalText(2000),
        // Reporter-facing "we fixed it by …" line for THIS item, shown next to
        // its quoted report in the combined email. Falls back to public_summary.
        fix_note: optionalText(2000),
      }),
    )
    .min(1)
    .max(50),
  // Optional intro/summary shown once at the top (above the per-item breakdown).
  reply_message: optionalText(4000),
  notify_reporter: z.boolean().optional(),
});

feedbackQueueRouter.post("/batch-resolve", replayAccountWrite, async (req, res, next) => {
  try {
    const parsed = BatchResolveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const { status, items, reply_message, notify_reporter } = parsed.data;
    const order = items.map((i) => i.id);
    const summaryById = new Map(items.map((i) => [i.id, i.public_summary]));
    const fixNoteById = new Map(items.map((i) => [i.id, i.fix_note]));

    const rows = await meta
      .selectFrom("feedback")
      .select(["id", "status", "user_id", "org_id", "message", "context", "origin", "origin_ref", "announce_message_id", "announce_channel_id", "type", "admin_notes", "triage_summary"])
      .where("id", "in", order)
      .execute();
    const found = new Set(rows.map((r) => r.id));
    if (rows.length === 0) {
      res.status(404).json({ error: { code: "not_found", message: "No matching feedback." } });
      return;
    }

    // 1) Resolve each item; post its OWN public changelog only on a fresh
    //    resolved transition (so a re-send doesn't double-post).
    await meta.updateTable("feedback").set({ status, updated_at: new Date() }).where("id", "in", [...found]).execute();
    // Resolving never publishes (#7460): the public line is stored for the
    // owner, and an agent's reply to anyone but the owner is held beside it.
    const agent = callerIsAgent(req.session);
    const sendable = new Set<string>();
    for (const row of rows) {
      if (!notify_reporter) continue;
      if (resolveMayReplyNow({ callerIsAgent: agent, reporterIsOperator: agent ? await reporterIsOperator(row) : true })) sendable.add(row.id);
      else {
        const message = (fixNoteById.get(row.id) || reply_message || "").trim() || null;
        await meta
          .updateTable("feedback")
          .set({ held_reply: sql`${JSON.stringify({ message, status })}::jsonb` })
          .where("id", "=", row.id)
          .execute();
      }
    }
    for (const row of rows) {
      const isResolved = status === "resolved";
      const freshlyResolved = isResolved && row.status !== "resolved";
      if (sendable.has(row.id) && row.origin === "discord") {
        const ref = (row.origin_ref ?? {}) as { thread_id?: string };
        if (ref.thread_id) {
          // Send what we ACTUALLY did (the per-item fix / reply), not a generic
          // line — mirrors the email's per-item block + the single-resolve DM.
          // The reporter's report is already in the thread, so don't re-quote it.
          const did = (fixNoteById.get(row.id) || summaryById.get(row.id) || reply_message || "").trim();
          const dmsg = feedbackReplyText(isResolved ? "resolved" : "wontfix", did);
          // DETACHED: a Discord thread reply; the reply is recorded on the ticket below either way
          void pokeDiscordResolved({ thread_id: ref.thread_id, text: dmsg });
        }
      }
      // Record our per-item reply on the thread so it shows in /me/feedback.
      if (sendable.has(row.id)) {
        const teamText = (fixNoteById.get(row.id) || reply_message || "").trim();
        if (teamText) {
          const teamEntry = { at: new Date().toISOString(), from: productName(), text: teamText, role: "team" as const };
          await meta
            .updateTable("feedback")
            .set({ followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([teamEntry])}::jsonb` })
            .where("id", "=", row.id)
            .execute();
        }
      }
      if (row.status !== status) {
        // The card follows the state; its "what we did" line waits for publish.
        reflectFeedbackCard({ ...row, status });
        // The mark on the report itself. The single-item PATCH has always poked
        // the stage; this path never did, so a BATCH close left every one of its
        // items without the emoji — the exact status trail the operator reads
        // the channel for, missing precisely when several things shipped at
        // once.
        pokeDiscordFeedbackStage({
          feedback_id: row.id,
          stage: isResolved ? "shipped" : "passed",
          message_id: row.announce_message_id,
          channel_id: row.announce_channel_id,
        });
      }
      if (freshlyResolved) {
        const held = summaryToHold({ public_summary: summaryById.get(row.id) ?? fixNoteById.get(row.id), reply_message });
        if (held) await meta.updateTable("feedback").set({ held_summary: held, published_at: null }).where("id", "=", row.id).execute();
      }
    }

    // 2) ONE combined reporter notification per distinct reporter.
    const notifiedReporters: string[] = [];
    if (notify_reporter && reply_message?.trim()) {
      const byUser = new Map<string, typeof rows>();
      for (const row of rows) {
        if (!row.user_id || !sendable.has(row.id)) continue;
        const list = byUser.get(row.user_id) ?? [];
        list.push(row);
        byUser.set(row.user_id, list);
      }
      for (const [userId, userRowsRaw] of byUser) {
        const userRows = [...userRowsRaw].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        let orgId = userRows.find((r) => r.org_id)?.org_id ?? null;
        if (!orgId) {
          const m = await meta
            .selectFrom("org_memberships")
            .select("org_id")
            .where("user_id", "=", userId)
            .orderBy("joined_at", "asc")
            .executeTakeFirst();
          orgId = m?.org_id ?? null;
        }
        if (!orgId) continue;
        // Tokenized Reply-To so a reply to this combined email threads back
        // inbound (Cloudflare → /inbound-email → appended as a followup) instead
        // of vanishing into the sender mailbox — the SAME threading the
        // single-resolve path gets. A batch email covers several of one
        // reporter's items, so thread to the first (userRows is order-sorted);
        // any of them reopens the conversation for that person. Omitting this was
        // the gap that stranded a reporter's reply (2026-07-12).
        const replyAddr = feedbackReplyAddress(userRows[0]!.id);
        let email: { subject: string; text: string; html?: string; replyTo?: string } | undefined;
        if (status === "resolved") {
          const u = await meta.selectFrom("users").select(["display_name"]).where("id", "=", userId).executeTakeFirst();
          const hi = u?.display_name ? `Hi ${u.display_name},` : "Hi,";
          const plural = userRows.length > 1;
          // Per-item "you reported X → we fixed it by Y" blocks, after the
          // optional intro/summary. Each pairs the reporter's own words with the
          // specific fix, so the email is both a scannable summary AND a record.
          const bq = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
          const blocks = userRows
            .map((r) => {
              const reported = (r.message ?? "").trim().slice(0, 600);
              const fix = (fixNoteById.get(r.id) || summaryById.get(r.id) || "").trim();
              const head = `You reported:\n${bq(reported)}`;
              return fix ? `${head}\n\n${fix}` : head;
            })
            .join("\n\n");
          const intro = reply_message.trim();
          // HTML: one styled quote+fix block per item (escaped), mirroring the text.
          const htmlBlocks = userRows
            .map((r) => {
              const reported = (r.message ?? "").trim().slice(0, 600);
              const fix = (fixNoteById.get(r.id) || summaryById.get(r.id) || "").trim();
              const q = `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">You reported:</p><blockquote style="margin:0 0 10px;padding:10px 16px;border-left:3px solid #c7b8a6;background:#f6f3ee;color:#374151;border-radius:0 6px 6px 0;white-space:pre-wrap;">${escHtml(reported)}</blockquote>`;
              const f = fix ? `<p style="margin:0 0 18px;">${escHtml(fix).replace(/\n/g, "<br>")}</p>` : "";
              return q + f;
            })
            .join("");
          email = {
            subject: plural ? `Your ${productName()} requests are live` : `Your ${productName()} request is live`,
            text:
              `${hi}\n\n` +
              (intro ? `${intro}\n\n` : "") +
              `${blocks}\n\n` +
              `Thanks for helping make ${productName()} better.\nThe ${productName()} team`,
            html: `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;padding:24px 12px;"><div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.5;max-width:560px;margin:0 auto;overflow-wrap:anywhere;word-break:break-word;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;"><p style="margin:0 0 16px;">${escHtml(hi)}</p>${intro ? `<p style="margin:0 0 16px;">${escHtml(intro).replace(/\n/g, "<br>")}</p>` : ""}${htmlBlocks}${emailableUrl("/me/feedback") ? `<p style="margin:14px 0 0;"><a href="${escHtml(emailableUrl("/me/feedback")!)}" style="display:inline-block;background:#8a6f47;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">View your feedback</a></p>` : ""}<p style="margin:18px 0 0;color:#6b7280;font-size:12px;">The ${escHtml(productName())} team</p></div></body></html>`,
            replyTo: replyAddr ?? undefined,
          };
        }
        const { deliveredVia } = await notifyAccount({
          userId,
          representativeOrgId: orgId,
          notificationType: "platform.feedback.replied",
          message: reply_message.trim(),
          // PAGE-LINK: one message about several of the reporter's items, so their whole thread with us
          link_url: "/me/feedback",
          email,
        });
        if (deliveredVia.length) notifiedReporters.push(userId);
      }
    }

    res.json({
      resolved: [...found],
      missing: order.filter((id) => !found.has(id)),
      notified_reporters: notifiedReporters.length,
      held: { replies: rows.filter((r) => notify_reporter && !sendable.has(r.id)).map((r) => r.id) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/feedback/:id/attachments/:fileId/raw — stream a reporter's
// screenshot. The bytes live in the REPORTER's workspace core-files; we read
// them server-side under the feedback's own org_id (so the endpoint can't be
// pointed at another org's file — a non-matching id just reads null). Only
// file_ids actually listed on the feedback row are served. Images only.
feedbackQueueRouter.get("/:id/attachments/:fileId/raw", async (req, res, next) => {
  try {
    const fb = await meta
      .selectFrom("feedback")
      .select(["org_id", "attachments"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "not_found", message: "no such attachment" } });
      return;
    }
    const atts = (fb.attachments ?? []) as Array<{ file_id: string; org_id?: string | null }>;
    const att = atts.find((a) => a.file_id === req.params.fileId);
    // An attachment may name the org its BYTES live in, which is not the
    // reporter's workspace. A Discord reporter has no account and no workspace,
    // so the row's org_id is null and always will be — saying otherwise would
    // claim they have an install we cannot see. Their screenshots are kept in
    // the operator's own workspace instead, and the entry records that.
    const bytesOrg = att?.org_id ?? fb.org_id;
    if (!att || !bytesOrg) {
      res.status(404).json({ error: { code: "not_found", message: "no such attachment" } });
      return;
    }
    const variant = req.query.variant === "thumb" || req.query.variant === "medium" ? req.query.variant : "medium";
    const file =
      (await platform().files.read(bytesOrg, req.params.fileId, variant)) ??
      (await platform().files.read(bytesOrg, req.params.fileId, "original"));
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    if (SHOWN_INLINE.has(file.mimeType.toLowerCase())) {
      res.type(file.mimeType);
    } else {
      res.type("application/octet-stream");
      res.setHeader("Content-Disposition", "attachment");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(file.bytes));
  } catch (err) {
    next(err);
  }
});
