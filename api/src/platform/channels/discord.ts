// Discord channel — POSTs to a server-side incoming webhook URL.
//
// Discord's webhook contract: any POST with `content` ≤ 2000 chars
// renders as a message in the channel the webhook is wired to.
// Optional `embeds[]` for richer formatting; we attach one with the
// notification's link_url so users can click through.
//
// No auth keys — the webhook URL itself is the secret.
// Per-user config lives in notification_subscriptions.config:
//   { webhook_url: "https://discord.com/api/webhooks/<id>/<token>" }

import { postJson } from "./http-helpers.js";
import type { Channel, ChannelEvent } from "./types.js";

interface DiscordConfig {
  webhook_url?: string;
}

function readConfig(payload: unknown): DiscordConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as DiscordConfig;
  if (typeof cfg.webhook_url !== "string" || cfg.webhook_url.length === 0) {
    return null;
  }
  if (!cfg.webhook_url.startsWith("https://discord.com/api/webhooks/")) {
    return null;
  }
  return cfg;
}

export const discordChannel: Channel = {
  name: "discord",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg?.webhook_url) {
      console.warn(`[notify:discord] subscription has no webhook_url; skipping`);
      return false;
    }
    // Title prefix mirrors the in-app card so users can correlate.
    const title = `[${event.eventType}]`;
    const content = `${title} ${event.message}`.slice(0, 2000);
    const body: Record<string, unknown> = { content };
    if (event.link_url) {
      body.embeds = [
        {
          description: `[Open in Cobblr](${event.link_url})`,
        },
      ];
    }
    return postJson({
      url: cfg.webhook_url,
      body,
      channelName: "discord",
    });
  },
};
