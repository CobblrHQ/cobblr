// Discord channel — POSTs to a server-side incoming webhook URL.
//
// Plain notifications render as a `content` message (≤2000 chars) + an embed
// with the "Open in Cobblr" link. A module can send a RICHER post by attaching
// `payload.embed` (title / color / fields) and `payload.links` (extra links) —
// and `payload.embed.image_url`, which we grab a single frame from (a webcam
// snapshot) and upload alongside the embed. This is what digifab's print updates
// use to beat the OctoEverywhere/OctoPrint-Discord-plugin experience: progress +
// ETA + a live snapshot + a "Live view" link, in one post.
//
// No auth keys — the webhook URL itself is the secret. Per-user config lives in
// notification_subscriptions.config: { webhook_url: "https://discord.com/api/webhooks/<id>/<token>" }.

import { postJson } from "./http-helpers.js";
import { grabJpegFrame } from "./image-grab.js";
import type { Channel, ChannelEvent } from "./types.js";

interface DiscordConfig {
  webhook_url?: string;
}
interface DiscordEmbedSpec {
  title?: string;
  color?: number;
  fields?: Array<{ name?: string; value?: string; inline?: boolean }>;
  image_url?: string;
}
interface DiscordPayload {
  links?: Array<{ label?: string; url?: string }>;
  embed?: DiscordEmbedSpec;
}

const WEBHOOK_PREFIX = "https://discord.com/api/webhooks/";

function readConfig(payload: unknown): DiscordConfig | null {
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload as DiscordConfig;
  if (typeof cfg.webhook_url !== "string" || !cfg.webhook_url.startsWith(WEBHOOK_PREFIX)) return null;
  return cfg;
}

function linkLine(event: ChannelEvent, extra?: DiscordPayload["links"]): string | null {
  const links: string[] = [];
  if (event.link_url) links.push(`[Open in Cobblr](${event.link_url})`);
  if (Array.isArray(extra)) {
    for (const l of extra) {
      if (l && typeof l.url === "string" && /^https?:\/\//.test(l.url)) links.push(`[${(l.label ?? "Link").slice(0, 40)}](${l.url})`);
    }
  }
  return links.length ? links.join(" · ") : null;
}

export const discordChannel: Channel = {
  name: "discord",
  async deliver(event: ChannelEvent): Promise<boolean> {
    const cfg = readConfig(event.subscriptionConfig);
    if (!cfg?.webhook_url) {
      console.warn(`[notify:discord] subscription has no webhook_url; skipping`);
      return false;
    }
    const p = (event.payload ?? {}) as DiscordPayload;
    const content = event.message.slice(0, 2000);
    const desc = linkLine(event, p.links);

    // Rich embed (digifab print updates) — title, color, fields, + a snapshot.
    if (p.embed) {
      const embed: Record<string, unknown> = {};
      if (p.embed.title) embed.title = p.embed.title.slice(0, 256);
      if (typeof p.embed.color === "number") embed.color = p.embed.color;
      if (desc) embed.description = desc;
      if (Array.isArray(p.embed.fields)) {
        embed.fields = p.embed.fields
          .filter((f) => f?.name && f?.value)
          .slice(0, 10)
          .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: f.inline ?? true }));
      }
      // Try to attach a live snapshot grabbed from the camera URL.
      const frame = p.embed.image_url ? await grabJpegFrame(p.embed.image_url) : null;
      if (frame) {
        embed.image = { url: "attachment://snapshot.jpg" };
        return postMultipart(cfg.webhook_url, { content, embeds: [embed] }, frame);
      }
      return postJson({ url: cfg.webhook_url, body: { content, embeds: [embed] }, channelName: "discord" });
    }

    // Plain notification — content + a link embed (the original behaviour).
    const body: Record<string, unknown> = { content };
    if (desc) body.embeds = [{ description: desc }];
    return postJson({ url: cfg.webhook_url, body, channelName: "discord" });
  },
};

/** POST a Discord webhook as multipart so we can attach the snapshot image. */
async function postMultipart(url: string, payloadJson: unknown, jpeg: Buffer): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payloadJson));
    form.append("files[0]", new Blob([jpeg], { type: "image/jpeg" }), "snapshot.jpg");
    const res = await fetch(url, { method: "POST", body: form, signal: controller.signal });
    if (!res.ok) {
      console.warn(`[notify:discord] ${url} → ${res.status} (multipart)`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[notify:discord] ${url} → ${(err as Error).message} (multipart)`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
