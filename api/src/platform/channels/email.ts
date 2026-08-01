// Email channel — sends a notification by email. Cobblr does NOT host outbound
// mail; the user brings their own delivery, picking ONE provider in the
// subscription config (notification_subscriptions.config). The provider config
// shape + per-provider transport live in ../email-send.ts, shared with the
// platform BYO auth-email sender.
//
// Subject is `[<event_type>] <first 60 chars>`; body is plain text (the full
// message + a link if any) — no HTML, which keeps every provider's payload
// trivial and dodges email-client rendering quirks.

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

export const emailChannel: Channel = {
  name: "email",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg) return false;
    const subject =
      `[${event.eventType}] ` + event.message.slice(0, 60) + (event.message.length > 60 ? "…" : "");
    const text = [
      event.message,
      "",
      event.link_url ? `Link: ${absoluteAppUrl(event.link_url)}` : null,
      "",
      `Priority: ${event.priority}`,
      `Sent by Cobblr.`,
    ]
      .filter((line) => line !== null)
      .join("\n");
    try {
      await sendEmailVia(cfg, subject, text);
      return true;
    } catch (err) {
      console.warn(`[notify:email] ${cfg.provider} send failed: ${(err as Error).message}`);
      return false;
    }
  },
};
