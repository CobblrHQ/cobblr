// Email channel — sends a notification by email. Cobblr does NOT host outbound
// mail; the user brings their own delivery, picking ONE provider in the
// subscription config (notification_subscriptions.config). The provider config
// shape + per-provider transport live in ../email-send.ts, shared with the
// platform BYO auth-email sender.
//
// Subject is `[<event_type>] <first 60 chars>`; body is plain text (the full
// message + a link if any) — no HTML, which keeps every provider's payload
// trivial and dodges email-client rendering quirks.

import { productName } from "../product-name.js";
import { checkEmailConfig, sendEmailVia, type EmailConfig, type ValidConfig } from "../email-send.js";
import { absoluteAppUrl } from "../public-url.js";
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

function subjectAndText(event: ChannelEvent): { subject: string; text: string } {
  const subject = `[${event.eventType}] ` + event.message.slice(0, 60) + (event.message.length > 60 ? "…" : "");
  const text = [event.message, "", event.link_url ? `Link: ${absoluteAppUrl(event.link_url)}` : null, "", `Priority: ${event.priority}`, `Sent by ${productName()}.`]
    .filter((line) => line !== null)
    .join("\n");
  return { subject, text };
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
