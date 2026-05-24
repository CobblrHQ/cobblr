// webhook — the universal outbound connector. Posts a JSON body to
// any URL. Credentials hold an optional bearer token + optional HMAC
// secret. One action: post.
//
// This connector is the lowest common denominator — every other HTTP
// service can be wired up via this until a dedicated connector exists.

import { platform } from "@cobblr/platform-contract";

export function register(): void {
  platform().integrations.registerConnector({
    id: "webhook",
    label: "Generic webhook",
    describeCredentials: () => ({
      url: { label: "Target URL", secret: false },
      bearer_token: { label: "Bearer token (optional)", secret: true },
      hmac_secret: { label: "HMAC signing secret (optional)", secret: true },
    }),
    actions: [
      {
        id: "post",
        label: "POST JSON",
        description: "POST the rendered body (or event payload) as JSON.",
      },
    ],
    invoke: async (ctx, actionId) => {
      if (actionId !== "post") {
        throw new Error(`webhook: unknown action ${actionId}`);
      }
      const url = String(ctx.credentials.url ?? "");
      if (!url) throw new Error("webhook: no URL configured");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "cobblr-integrations/0.1",
      };
      const bearer = ctx.credentials.bearer_token;
      if (typeof bearer === "string" && bearer) {
        headers.authorization = `Bearer ${bearer}`;
      }
      // Body: rendered template wins; else event payload; else args.
      const body =
        ctx.rendered ??
        JSON.stringify(ctx.event?.payload ?? ctx.args ?? {});
      const secret = ctx.credentials.hmac_secret;
      if (typeof secret === "string" && secret) {
        const { createHmac } = await import("node:crypto");
        const sig = createHmac("sha256", secret).update(body).digest("hex");
        headers["x-cobblr-signature"] = `sha256=${sig}`;
      }
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`webhook: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      }
      return { status: res.status };
    },
    testConnection: async (credentials) => {
      const url = String(credentials.url ?? "");
      if (!url) return { ok: false, error: "no url" };
      try {
        // HEAD first, fall back to GET. Some webhook targets reject HEAD.
        const res = await fetch(url, { method: "HEAD" }).catch(() =>
          fetch(url, { method: "GET" }),
        );
        return { ok: res.ok || res.status < 500 };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
