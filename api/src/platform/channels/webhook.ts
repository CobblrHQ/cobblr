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

import { lookup as dnsLookup } from "node:dns/promises";
import { absoluteAppUrl } from "../public-url.js";
import { isIP } from "node:net";
import { postJson } from "./http-helpers.js";
import { isPrivateIp } from "../../sandbox/ssrf.js";
import type { Channel, ChannelEvent } from "./types.js";

// Reject a user-set webhook URL that points at an internal address. Resolves
// DNS so a public hostname that maps to a private IP (rebind) is caught too.
// See docs/history/2026-06-10-prelaunch-audit.md #2.
async function isInternalUrl(rawUrl: string): Promise<boolean> {
  // Dev/test escape hatch — same one the integrations connector honors — so a
  // self-hoster (or the test suite's localhost mock) can target a LAN/loopback
  // service. Ignored in production, so prod stays guarded regardless.
  if (process.env.COBBLR_WEBHOOK_ALLOW_INTERNAL === "1" && process.env.NODE_ENV !== "production") {
    return false;
  }
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (isIP(host)) return isPrivateIp(host);
  try {
    const records = await dnsLookup(host, { all: true });
    return records.length === 0 || records.some((r) => isPrivateIp(r.address));
  } catch {
    return true; // unresolvable → treat as unsafe
  }
}

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
    // Block SSRF: a user-set webhook URL pointing at an internal host turns
    // every fired notification into a blind probe of the prod network.
    if (await isInternalUrl(cfg.url)) {
      console.warn(`[notify:webhook] blocked internal/unsafe url; skipping`);
      return false;
    }
    return postJson({
      url: cfg.url,
      headers: cfg.headers,
      body: {
        notification_id: event.notificationId,
        event_type: event.eventType,
        message: event.message,
        link_url: event.link_url ? absoluteAppUrl(event.link_url) : null,
        priority: event.priority,
        org_id: event.orgId,
        user_id: event.userId,
        occurred_at: new Date().toISOString(),
      },
      channelName: "webhook",
    });
  },
};
