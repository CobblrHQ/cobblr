// Slack channel — POSTs to an incoming webhook URL.
//
// Slack's webhook contract: { text: "..." } at minimum. blocks[]
// for rich formatting; we use a section block to surface the
// link_url as a clickable button-style link in the message.
//
// Per-user config in notification_subscriptions.config:
//   { webhook_url: "https://hooks.slack.com/services/<workspace>/<channel>/<token>" }

import { postJson } from "./http-helpers.js";
import type { Channel, ChannelEvent } from "./types.js";

interface SlackConfig {
  webhook_url?: string;
}

function readConfig(payload: unknown): SlackConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as SlackConfig;
  if (typeof cfg.webhook_url !== "string" || cfg.webhook_url.length === 0) {
    return null;
  }
  if (!cfg.webhook_url.startsWith("https://hooks.slack.com/")) {
    return null;
  }
  return cfg;
}

export const slackChannel: Channel = {
  name: "slack",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg?.webhook_url) {
      console.warn(`[notify:slack] subscription has no webhook_url; skipping`);
      return false;
    }
    const prefix = `[${event.eventType}]`;
    const body: Record<string, unknown> = {
      text: `${prefix} ${event.message}`,
    };
    if (event.link_url) {
      body.blocks = [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${prefix}* ${event.message}` },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Cobblr" },
              url: event.link_url,
            },
          ],
        },
      ];
    }
    return postJson({
      url: cfg.webhook_url,
      body,
      channelName: "slack",
    });
  },
};
