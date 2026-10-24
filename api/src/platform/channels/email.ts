// Email channel — sends a notification by email. Cobblr does NOT host outbound
// mail; the user brings their own delivery, picking ONE provider in the
// subscription config (notification_subscriptions.config). The provider config
// shape + per-provider transport live in ../email-send.ts, shared with the
// platform BYO auth-email sender.
//
// Subject is the message's own first line; body is plain text (the full
// message + a link if any) — no HTML, which keeps every provider's payload
// trivial and dodges email-client rendering quirks. Neither carries the event's
// key or the priority's enum: a reader has no use for them (#7544).

import { productName } from "../product-name.js";
import { checkEmailConfig, sendEmailVia, type EmailConfig, type ValidConfig } from "../email-send.js";
import { emailableUrl, NO_ADDRESS_NOTE, pointTo } from "../link-origin.js";
import type { Channel, ChannelEvent } from "./types.js";

/** Validate config for the chosen provider; null (+ a warn) if incomplete. */
function readConfig(payload: unknown): ValidConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const r = checkEmailConfig(payload as EmailConfig, true);
  if (!r.ok) {
    console.warn(`[notify:email] ${r.reason}; skipping`);
    return null;
  }
  return r.config;
}

const SUBJECT_MAX = 70;

/** The subject a notice reads as in an inbox: its own first line, in plain
 *  words. Never the event's key or a bullet list flattened and cut mid-word
 *  (#7544). A digest's first line is its count ("4 updates from your
 *  workspace:"), so its subject is that, not the first update. */
function subjectOf(message: string): string {
  const first = (message.split("\n").find((l) => l.trim()) ?? "").replace(/\*\*/g, "").replace(/^[•\-*]\s*/, "").trim().replace(/[:\s]+$/, "");
  if (first.length <= SUBJECT_MAX) return first || "A notice";
  const cut = first.slice(0, SUBJECT_MAX - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[,;:\s]+$/, "")}…`;
}

export function subjectAndText(event: ChannelEvent): { subject: string; text: string } {
  const link = event.link_url ? emailableUrl(event.link_url) : null;
  // The priority is said only when it asks for attention, and in words.
  const urgency = event.priority === "urgent" ? "This one is marked urgent." : event.priority === "high" ? "This one is marked important." : null;
  const text = [event.message.replace(/\*\*/g, ""), "", link ? `Open it: ${link}` : event.link_url ? NO_ADDRESS_NOTE : null, urgency ? "" : null, urgency, "",
    pointTo("To change or stop routine email, open Notification settings", emailableUrl("/me/communication")),
    event.subscriptionConfig == null ? null : pointTo("Workspace email bindings can be removed in Channels", emailableUrl("/me/notification-channels")),
    "", `Sent by ${productName()}.`]
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { subject: subjectOf(event.message), text };
}

async function accountEmail(event: ChannelEvent): Promise<boolean> {
  const { hasAuthEmailSender, sendAuthEmail } = await import("../hosted-seams.js");
  if (!hasAuthEmailSender()) return false;
  const { meta } = await import("../../db/meta.js");
  const u = await meta.selectFrom("users").select("email").where("id", "=", event.userId).executeTakeFirst();
  if (!u?.email) return false;
  return sendAuthEmail({ to: u.email, ...subjectAndText(event), kind: "notification" });
}

export const emailChannel: Channel = {
  name: "email",
  async deliver(event: ChannelEvent): Promise<boolean> {
    // No binding of its own: an account notice held over its hourly cap
    // (#7076), sent as notifyAccount sends one live, from the platform's
    // sender to the account's address.
    if (event.subscriptionConfig == null) return accountEmail(event);
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg) return false;
    const { subject, text } = subjectAndText(event);
    try {
      await sendEmailVia(cfg, subject, text);
      return true;
    } catch (err) {
      console.warn(`[notify:email] ${cfg.provider} send failed: ${(err as Error).message}`);
      return false;
    }
  },
};
