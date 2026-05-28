// webhook — the universal outbound connector. Posts a JSON body to
// any URL. Credentials hold an optional bearer token + optional HMAC
// secret. One action: post.
//
// This connector is the lowest common denominator — every other HTTP
// service can be wired up via this until a dedicated connector exists.

import net from "node:net";
import { platform } from "@cobblr/platform-contract";

// SSRF guard for admin-configured outbound URLs: block non-http(s)
// schemes and obvious internal targets (loopback / private / link-local,
// incl. the cloud metadata IP 169.254.169.254). Hostname-based — does
// NOT defend against DNS-rebinding (a deeper follow-up).
function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const a = p[0]!, b = p[1]!;
  return (
    a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function assertSafeOutboundUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("webhook: invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("webhook: only http(s) URLs are allowed");
  }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error("webhook: internal host blocked");
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error("webhook: private/loopback address blocked");
  }
}

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
      assertSafeOutboundUrl(url);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
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
        assertSafeOutboundUrl(url);
        // HEAD first, fall back to GET. Some webhook targets reject HEAD.
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) }).catch(() =>
          fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000) }),
        );
        return { ok: res.ok || res.status < 500 };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
