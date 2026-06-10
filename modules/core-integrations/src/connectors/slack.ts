// slack — Slack incoming-webhook connector. The user pastes a webhook
// URL from a Slack app they configured; we POST messages to it.
//
// One action: post-message. Args: { text, blocks? }. If a template
// rendered string is provided, it goes in `text`.

import { platform } from "@cobblr/platform-contract";

export function register(): void {
  platform().integrations.registerConnector({
    id: "slack",
    label: "Slack (incoming webhook)",
    describeCredentials: () => ({
      webhook_url: { label: "Incoming webhook URL", secret: true },
    }),
    actions: [
      {
        id: "post-message",
        label: "Post message",
        description: "Post text into the channel the webhook targets.",
        argsSchema: {
          text: { label: "Message text", type: "text" },
        },
      },
    ],
    invoke: async (ctx, actionId) => {
      if (actionId !== "post-message") {
        throw new Error(`slack: unknown action ${actionId}`);
      }
      const url = String(ctx.credentials.webhook_url ?? "");
      if (!url) throw new Error("slack: no webhook URL configured");
      // Host-lock to the official Slack webhook endpoint — a stored
      // webhook_url is credential-controlled, so without this it's an SSRF
      // primitive (post to internal hosts, read up to 200 chars of the
      // response back via the error). See 2026-06-10 pre-launch audit #2.
      if (!url.startsWith("https://hooks.slack.com/"))
        throw new Error("slack: webhook URL must be a https://hooks.slack.com/ address");
      const text = ctx.rendered ?? String(ctx.args.text ?? "");
      if (!text) throw new Error("slack: empty message");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`slack: ${res.status} ${t.slice(0, 200)}`);
      }
      return { status: res.status };
    },
    testConnection: async (credentials) => {
      const url = String(credentials.webhook_url ?? "");
      if (!url || !url.startsWith("https://hooks.slack.com/"))
        return { ok: false, error: "URL doesn't look like a Slack webhook" };
      return { ok: true };
    },
  });
}
