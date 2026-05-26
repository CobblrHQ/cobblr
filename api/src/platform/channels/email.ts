// Email channel — sends via SMTP using nodemailer. User provides
// their own SMTP creds in the subscription config (we don't ship
// SMTP infrastructure; users plug in their existing provider:
// Gmail with an app password, Fastmail, AWS SES SMTP, Postmark, ...).
//
// Per-user config in notification_subscriptions.config:
//   {
//     smtp_host: "smtp.fastmail.com",
//     smtp_port: 465,
//     smtp_user: "user@example.com",
//     smtp_pass: "<app-password>",
//     smtp_secure?: true,    // true for 465, false for 587 + STARTTLS
//     from: "cobblr@example.com",
//     to: "ray@example.com"
//   }
//
// Subject is `[<event_type>] <first 60 chars of message>`. Body is
// plain text with the full message + a link (if any). Keeping HTML
// off keeps the driver dependency-free + dodges every email-client
// rendering quirk.

import nodemailer from "nodemailer";
import type { Channel, ChannelEvent } from "./types.js";

interface EmailConfig {
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_secure?: boolean;
  from?: string;
  to?: string;
}

function readConfig(payload: unknown): EmailConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as EmailConfig;
  if (
    typeof cfg.smtp_host !== "string" ||
    typeof cfg.smtp_user !== "string" ||
    typeof cfg.smtp_pass !== "string" ||
    typeof cfg.from !== "string" ||
    typeof cfg.to !== "string"
  ) {
    return null;
  }
  return cfg;
}

export const emailChannel: Channel = {
  name: "email",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg) {
      console.warn(
        "[notify:email] subscription config missing one of smtp_host/smtp_user/smtp_pass/from/to; skipping",
      );
      return false;
    }
    const port = cfg.smtp_port ?? 465;
    // smtp_secure default mirrors the common convention: 465 = TLS,
    // 587 = STARTTLS, everything else = STARTTLS as well unless
    // explicitly overridden.
    const secure = cfg.smtp_secure ?? port === 465;
    const transport = nodemailer.createTransport({
      host: cfg.smtp_host,
      port,
      secure,
      auth: { user: cfg.smtp_user!, pass: cfg.smtp_pass! },
      // Keep the connection short. SMTP servers tend to drop idle.
      connectionTimeout: 5000,
      socketTimeout: 5000,
    });
    const subject =
      `[${event.eventType}] ` + event.message.slice(0, 60) +
      (event.message.length > 60 ? "…" : "");
    const text = [
      event.message,
      "",
      event.link_url ? `Link: ${event.link_url}` : null,
      "",
      `Priority: ${event.priority}`,
      `Sent by Cobblr.`,
    ]
      .filter((line) => line !== null)
      .join("\n");
    try {
      await transport.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject,
        text,
      });
      return true;
    } catch (err) {
      console.warn(`[notify:email] send failed: ${(err as Error).message}`);
      return false;
    } finally {
      transport.close();
    }
  },
};
