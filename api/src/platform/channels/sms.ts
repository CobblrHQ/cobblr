// SMS channel — sends via Twilio's REST API.
//
// Twilio's send-SMS endpoint is a POST against
//   https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json
// with Basic auth (SID:auth_token) and form-encoded body
// `{ From, To, Body }`.
//
// Per-user config in notification_subscriptions.config:
//   {
//     account_sid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
//     auth_token:  "<32-char hex>",
//     from_number: "+1NNNNNNNNNN",
//     to_number:   "+1NNNNNNNNNN"
//   }
//
// Body is `[<event_type>] <message>`, hard-truncated to 1000 chars
// (Twilio splits >160 char messages into multiple segments
// automatically; 1000 chars caps at ~7 segments which is the
// reasonable upper bound for a notification).

import { postJson } from "./http-helpers.js";
import type { Channel, ChannelEvent } from "./types.js";

interface SmsConfig {
  account_sid?: string;
  auth_token?: string;
  from_number?: string;
  to_number?: string;
}

function readConfig(payload: unknown): SmsConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as SmsConfig;
  if (
    typeof cfg.account_sid !== "string" ||
    !cfg.account_sid.startsWith("AC") ||
    typeof cfg.auth_token !== "string" ||
    typeof cfg.from_number !== "string" ||
    typeof cfg.to_number !== "string"
  ) {
    return null;
  }
  return cfg;
}

export const smsChannel: Channel = {
  name: "sms",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg) {
      console.warn(
        "[notify:sms] subscription config missing one of account_sid/auth_token/from_number/to_number; skipping",
      );
      return false;
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Messages.json`;
    const basic = Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString("base64");
    const body = `[${event.eventType}] ${event.message}`.slice(0, 1000);
    return postJson({
      url,
      formEncoded: true,
      body: {
        From: cfg.from_number,
        To: cfg.to_number,
        Body: body,
      },
      headers: { Authorization: `Basic ${basic}` },
      channelName: "sms",
      // Twilio is occasionally slow; a touch more generous than the
      // default 5s.
      timeoutMs: 10_000,
    });
  },
};
