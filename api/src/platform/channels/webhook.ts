// Generic webhook channel — POSTs the full ChannelEvent JSON to a
// user-supplied URL. The escape hatch for "I want Cobblr events in
// my own service / IFTTT / Pushover / whatever."
//
// Per-user config in notification_subscriptions.config:
//   {
//     url: "https://my-service.example.com/hooks/cobblr",
//     headers?: { "X-Hook-Token": "...", ... }
//   }
//
// We send a stable, documented JSON envelope so receivers can rely
// on the shape:
//   {
//     notification_id, event_type, message, link_url,
//     priority, org_id, user_id, occurred_at
//   }

import { postJson } from "./http-helpers.js";
import type { Channel, ChannelEvent } from "./types.js";

interface WebhookConfig {
  url?: string;
  headers?: Record<string, string>;
}

function readConfig(payload: unknown): WebhookConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as WebhookConfig;
  if (typeof cfg.url !== "string" || cfg.url.length === 0) return null;
  if (!/^https?:\/\//.test(cfg.url)) return null;
  return cfg;
}

export const webhookChannel: Channel = {
  name: "webhook",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg?.url) {
      console.warn(`[notify:webhook] subscription has no url; skipping`);
      return false;
    }
    return postJson({
      url: cfg.url,
      headers: cfg.headers,
      body: {
        notification_id: event.notificationId,
        event_type: event.eventType,
        message: event.message,
        link_url: event.link_url,
        priority: event.priority,
        org_id: event.orgId,
        user_id: event.userId,
        occurred_at: new Date().toISOString(),
      },
      channelName: "webhook",
    });
  },
};
