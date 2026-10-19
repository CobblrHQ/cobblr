// The delivery half of resolving a feedback item: the Discord card that follows
// the item, the reporter's reply, and the public resolved post. Resolving does
// not call the last two by itself (#7460): the reply goes now only for the
// owner's own ticket or a person at the console, and the public post only from
// the owner's publish (feedback-publish.ts). Moved out of super-admin.ts, which
// is over the route-file size cap and only mounts new groups (#7385).

import { productName } from "../../platform/product-name.js";
import { sql, type Selectable } from "kysely";
import { feedbackCard, resolutionDelivery } from "../feedback-card.js";
import { meta } from "../../db/meta.js";
import { hasAuthEmailSender, sendAuthEmail } from "../../platform/hosted-seams.js";
import { notifyAccount } from "../../platform/notifications.js";
import { feedbackEmail } from "../../platform/feedback-email.js";
import { discordInviteFor } from "../../platform/feedback-discord-invite.js";
import { feedbackReplyText } from "../../platform/feedback-reply-text.js";
import { announce, editAnnouncement } from "../../platform/announce.js";
import { reporterCardFields } from "../../platform/feedback-card.js";
import { pokeDiscordResolved, sendDiscordDm, dmOutcome } from "../../platform/discord-bot-trigger.js";
import { reporterReplyRoute } from "../../platform/feedback-reply-route.js";
import type { FeedbackTable } from "../../db/schema.js";
import type { DeliveryOutcomes } from "@cobblr/platform-contract/delivery-outcome";
import { emailableUrl } from "../../platform/link-origin.js";
import { feedbackReplyAddress } from "../../platform/feedback-reply.js";

// Bring the item's ONE Discord card up to date with the row. Fire-and-forget:
// a card that cannot be edited must never fail the write that moved the item.
// No-op for an item with no card (never posted, or posted before ids were kept).
export function reflectFeedbackCard(
  row: {
    id: string;
    type: string | null;
    status: string | null;
    message: string | null;
    admin_notes?: string | null;
    triage_summary?: string | null;
    origin_ref: unknown;
    announce_message_id: string | null;
  },
  opts: { fixed?: string | null; fields?: Array<{ name: string; value: string; inline?: boolean }> } = {},
): void {
  if (!row.announce_message_id) return;
  const card = feedbackCard(row, { fixed: opts.fixed });
  const originGuildId = ((row.origin_ref ?? {}) as { guild_id?: string }).guild_id ?? null;
  void editAnnouncement("feedback.new", { messageId: row.announce_message_id, originGuildId }, {
    title: card.title,
    body: card.body,
    color: card.color,
    fields: opts.fields,
    originGuildId,
  }).then((ok) => {
    if (!ok) console.warn(`[feedback] card for ${row.id} not updated (status ${row.status})`);
  });
}

export type ReleaseRow = Pick<
  Selectable<FeedbackTable>,
  "id" | "status" | "user_id" | "org_id" | "message" | "context" | "origin" | "origin_ref" | "announce_message_id" | "reachable" | "contact_email" | "type" | "admin_notes" | "triage_summary"
>;
export interface ReplyInput {
  status?: string | null;
  reply_message?: string | null;
  public_summary?: string | null;
  notify_reporter?: boolean;
}

// The reporter-facing half of a resolve: the reply on the ticket, then the
// door the reporter is reachable by. Called with the owner's go only: by a
// person at the console, for the owner's own ticket, or by publish.
export async function deliverReporterReply(
  row: ReleaseRow,
  input: ReplyInput,
): Promise<{ notified: boolean; emailed: boolean; delivery: DeliveryOutcomes }> {
  // Optionally close the loop with the reporter — "we looked at this / it's
  // fixed". Best-effort: a failed notification must not fail the triage update.
  let notified = false;
  let emailed = false;
  // WHY each channel did or didn't land — `emailed: false` alone can't tell an
  // operator "they opted out" from "our sender is down".
  let delivery: DeliveryOutcomes = {};
  // Record our reply on the item itself so it shows in the reporter's in-app
  // thread (/me/feedback) — the notification channels are just the ping.
  if (input.notify_reporter && input.reply_message?.trim()) {
    const teamEntry = { at: new Date().toISOString(), from: productName(), text: input.reply_message.trim(), role: "team" as const };
    await meta
      .updateTable("feedback")
      .set({ followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([teamEntry])}::jsonb` })
      .where("id", "=", row.id)
      .execute();
  }
  // Where the reply goes is decided in ONE place, for every origin
  // (feedback-reply-route.ts) — an origin with no door is a reply that
  // silently goes nowhere.
  const replyRoute = reporterReplyRoute({
    origin: row.origin,
    user_id: row.user_id,
    origin_ref: (row.origin_ref ?? null) as { thread_id?: string; user_id?: string } | null,
    reachable: row.reachable,
    contact_email: row.contact_email,
  });
  // A sandbox visitor who left an address on purpose: one email to it, in the
  // same words as an account's. Never to the account's own .invalid address.
  if (input.notify_reporter && replyRoute.via === "contact-email" && hasAuthEmailSender()) {
    const isResolved = input.status === "resolved";
    const reply = input.reply_message?.trim();
    if (isResolved || reply) {
      const mail = feedbackEmail({
        kind: isResolved ? "resolved" : "reply",
        greeting: "Hi,",
        report: row.message ?? "",
        body: reply || (isResolved ? "The issue you reported has been fixed - it's live now." : ""),
        feedbackUrl: emailableUrl("/"),
        replyAddress: null,
        discord: [],
      });
      const ok = await sendAuthEmail({ to: replyRoute.to, subject: mail.subject, text: mail.text, html: mail.html, kind: "notification" });
      emailed = ok;
      notified = ok || notified;
      delivery.email = ok ? "sent" : "send-failed";
    }
  }
  if (input.notify_reporter && replyRoute.via === "discord-thread") {
    {
      const ref = { thread_id: replyRoute.thread_id };
      // A written reply is the whole message. Nothing is prepended to it: the
      // API used to glue a deployment claim in front, which made the author's
      // own accurate timing wrong and left them no phrasing that survived.
      const did = input.reply_message?.trim() || input.public_summary?.trim();
      pokeDiscordResolved({
        thread_id: ref.thread_id,
        text: feedbackReplyText(input.status ?? "", did),
      });
      notified = true;
      // Fire-and-forget by design (the bot owns the Discord connection), so
      // "handed to the bot" is the most we can honestly claim.
      delivery.discord_dm = "sent";
    }
  }
  // A DM reporter with no account is reachable only through the DM they wrote
  // from — before this route existed, their reply was written and dropped.
  if (input.notify_reporter && replyRoute.via === "discord-dm") {
    const text = input.reply_message?.trim() || input.public_summary?.trim();
    if (text) {
      const dm = await sendDiscordDm({
        discord_user_id: replyRoute.discord_user_id,
        // Same rule as the thread path: what somebody wrote is the message.
        text: feedbackReplyText(input.status ?? "", text),
        summary: feedbackReplyText(input.status ?? "", text),
      });
      notified = dm.ok || notified;
      delivery.discord_dm = dmOutcome(dm);
    }
  }
  if (input.notify_reporter && replyRoute.via === "account" && row.user_id) {
    try {
      // The reporter's workspace: the org they filed from, else their first.
      let orgId = row.org_id ?? null;
      if (!orgId) {
        const m = await meta
          .selectFrom("org_memberships")
          .select("org_id")
          .where("user_id", "=", row.user_id)
          .orderBy("joined_at", "asc")
          .executeTakeFirst();
        orgId = m?.org_id ?? null;
      }
      if (orgId) {
        const isResolved = input.status === "resolved";
        const reply = input.reply_message?.trim();
        const defaultMsg = isResolved
          ? "The issue you reported has been fixed — it's live now."
          : input.status === "wontfix"
            ? "We reviewed your feedback — thanks for flagging it."
            : "We're looking into the feedback you sent.";
        // The reporter — for the greeting + the email address.
        const u = await meta
          .selectFrom("users")
          .select(["email", "display_name"])
          .where("id", "=", row.user_id)
          .executeTakeFirst();
        const hi = u?.display_name ? `Hi ${u.display_name},` : "Hi,";
        // Lead the bell + DM with the reporter's own words ("You reported: …")
        // then the fix — same shape as the email, so the message has context
        // instead of being a wall of fix text. A shorter quote than the email's
        // (a notification should stay scannable).
        const reportRaw = (row.message ?? "").trim();
        const reportQuote = reportRaw.length > 240 ? `${reportRaw.slice(0, 240)}…` : reportRaw;
        // Markdown blockquote — Discord renders `>` as a quoted block (a vertical
        // bar), and it still reads as a quote in the plain-text bell. Each line
        // is prefixed so a multi-line report stays inside the quote.
        const bq = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
        const reported = reportRaw ? `You reported:\n${bq(reportQuote)}` : "";
        const useContext = isResolved && !!reply && !!reported;
        // in-app bell: context + fix, NO greeting (a "Hi the author," is too much there).
        const message = useContext ? `${reported}\n\n${reply}` : (reply || defaultMsg);
        // Discord DM: the same, WITH the greeting (the more formal channel).
        const discordMessage = useContext ? `${hi}\n\n${reported}\n\n${reply}` : undefined;
        // Email both ways now that feedback is a conversation: "your request is
        // live" on resolve, and "we replied / have a question" on an OPEN item
        // when there's an explicit reply_message (so a clarifying question
        // actually reaches the reporter — not just the in-app bell). The latter
        // links them to their thread to answer. notifyAccount also honors the
        // matrix per channel + DMs them if Discord is verified.
        let email: { subject: string; text: string; html?: string; replyTo?: string; discordInvite?: boolean } | undefined;
        if (hasAuthEmailSender() && u?.email && (isResolved || reply)) {
          // Reply-by-email when wired (a tokenized Reply-To routes replies
          // back inbound); otherwise the email says replies are not seen and
          // points to the in-app thread. The Discord invitation rides along
          // while it can still help (feedback-discord-invite.ts).
          email = feedbackEmail({
            kind: isResolved ? "resolved" : "reply",
            greeting: hi,
            report: isResolved ? reportRaw : (row.message ?? ""),
            body: isResolved ? reply || defaultMsg : reply!,
            feedbackUrl: emailableUrl("/me/feedback"),
            replyAddress: feedbackReplyAddress(row.id),
            discord: await discordInviteFor(row.user_id),
          });
        }
        const { deliveredVia, outcomes } = await notifyAccount({
          userId: row.user_id,
          representativeOrgId: orgId,
          notificationType: "platform.feedback.replied",
          message,
          discordMessage,
          // Land them on their feedback thread to read our reply + respond.
          // PAGE-LINK: the reporter's whole thread with us, not one record
          link_url: "/me/feedback",
          email,
          // A reply answers on the channel the report came in on: a Discord
          // ticket gets the DM, everything else gets the email. The bell
          // records it either way. Before this, one reply arrived as an
          // email AND a DM saying the same sentence (reported 2026-08-24).
          originChannel: row.origin === "discord" || row.origin === "discord-dm" ? "discord_dm" : "email",
        });
        notified = deliveredVia.length > 0 || notified;
        emailed = deliveredVia.includes("email");
        delivery = outcomes;
      }
    } catch (err) {
      console.error("[super-admin] feedback-reply notification failed:", err);
    }
  }
  if (Object.keys(delivery).length > 0) {
    await meta
      .updateTable("feedback")
      .set({ reply_delivery: sql`${JSON.stringify(delivery)}::jsonb` })
      .where("id", "=", row.id)
      .execute();
  }
  return { notified, emailed, delivery };
}

// The public half of a resolve: the item's card becomes the resolved card, or a
// fresh resolved post when it has none. ONLY the owner's publish calls this
// (#7460, guarded by feedback-resolve-never-publishes.test.ts).
export async function postResolvedCard(row: ReleaseRow, fixed: string | null): Promise<void> {
  const ctx = (row.context ?? {}) as { route?: string };
  const reported = (row.message ?? "").slice(0, 1200);
  const cardFields = await reporterCardFields({ userId: row.user_id, orgId: row.org_id, route: ctx.route });
  // The resolved card threads UNDER the original announcement, so it has to
  // use the same webhook the original went to. Route it by the same origin
  // or the thread id names a message that does not exist on this webhook.
  const resolvedGuild = ((row.origin_ref ?? {}) as { guild_id?: string }).guild_id ?? null;
  // One item, one card: when the report's own card exists, it BECOMES the
  // resolved card. A second message was the complaint (2026-09-07). A fresh
  // post is only for an item that has no card to edit.
  if (resolutionDelivery(row) === "edit") {
    reflectFeedbackCard(row, { fixed: fixed ?? null, fields: cardFields });
  } else void announce("feedback.resolved", { // DETACHED: the public resolved post; the resolve is saved without it
    title: "✅ Feedback resolved",
    originGuildId: resolvedGuild,
    // When we have a "what we did" line, the post reads as a public changelog
    // entry (reported → fixed); otherwise just the original report.
    body: fixed ? `**Reported:** ${reported}\n\n**Fixed:** ${fixed.slice(0, 2400)}` : reported,
    color: 0x2e7d32,
    fields: cardFields,
    // Under the report it belongs to, not a fresh top-level card. The
    // channel already carries the report and (once triaged) its thread, so
    // a third message restating the same item is pure stream noise
    // (operator request, 2026-08-05: nest "resolved" in the same thread).
    // A thread started from a message shares that message's id, so the
    // stored announce_message_id IS the thread id.
    threadId: row.announce_message_id,
  });
}
