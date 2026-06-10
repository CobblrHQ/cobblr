// discord — Discord channel webhook connector. Same shape as slack:
// paste the webhook URL, post messages to it.

import { platform } from "@cobblr/platform-contract";

export function register(): void {
  platform().integrations.registerConnector({
    id: "discord",
    label: "Discord (channel webhook)",
    describeCredentials: () => ({
      webhook_url: { label: "Channel webhook URL", secret: true },
      username: { label: "Override username (optional)", secret: false },
    }),
    actions: [
      {
        id: "post-message",
        label: "Post message",
        description: "Post text into the channel the webhook targets.",
        argsSchema: {
          content: { label: "Message content", type: "text" },
        },
      },
    ],
    invoke: async (ctx, actionId) => {
      if (actionId !== "post-message") {
        throw new Error(`discord: unknown action ${actionId}`);
      }
      const url = String(ctx.credentials.webhook_url ?? "");
      if (!url) throw new Error("discord: no webhook URL configured");
      // Host-lock to the official Discord webhook endpoint — see slack.ts /
      // 2026-06-10 pre-launch audit #2 (otherwise this is an SSRF primitive).
      if (!url.startsWith("https://discord.com/api/webhooks/") &&
          !url.startsWith("https://discordapp.com/api/webhooks/"))
        throw new Error("discord: webhook URL must be a https://discord.com/api/webhooks/ address");
      const content = ctx.rendered ?? String(ctx.args.content ?? "");
      if (!content) throw new Error("discord: empty message");
      const body: Record<string, unknown> = { content };
      const username = ctx.credentials.username;
      if (typeof username === "string" && username) body.username = username;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`discord: ${res.status} ${t.slice(0, 200)}`);
      }
      return { status: res.status };
    },
    testConnection: async (credentials) => {
      const url = String(credentials.webhook_url ?? "");
      if (!url || !url.startsWith("https://discord.com/api/webhooks/"))
        return { ok: false, error: "URL doesn't look like a Discord webhook" };
      return { ok: true };
    },
  });
}
