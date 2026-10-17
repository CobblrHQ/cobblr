// http — the generic HTTP-out connector (the "escape hatch": one build, infinite
// reach). Unlike `webhook` (POST JSON only), this exposes a fully configurable
// request: method, URL (or a path appended to a base URL), custom headers, and
// query params — all template-rendered from the wire. The body is the rendered
// template (or the event payload). Lets a wire call ANY HTTP API without a
// dedicated connector — the make.com "HTTP" app equivalent.

import { registerOutboundConnector } from "../services.js";
import { sendFetch, idempotencyHeaderOf } from "../outbound-send.js";
import { safeFetch } from "./safe-fetch.js";
import { assertSafeOutboundUrl } from "./ssrf.js";

/** The scheme, host and port of an address ("https://host:8443"), lower-cased and
 *  with the scheme's default port dropped; null for anything that is not one. */
function originOf(address: string): string | null {
  try {
    const u = new URL(address);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function parseJsonObject(v: unknown): Record<string, string> {
  if (typeof v !== "string" || !v.trim()) return {};
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(o)) out[k] = String(val);
    return out;
  } catch {
    return {};
  }
}

export function register(): void {
  registerOutboundConnector({
    id: "http",
    label: "HTTP request",
    describeCredentials: () => ({
      base_url: { label: "Base URL (optional, prepended to a relative URL)", secret: false },
      bearer_token: { label: "Bearer token (optional)", secret: true },
      max_per_second: { label: "Most requests per second (optional)", secret: false },
      idempotency_header: { label: "Idempotency key header (default Idempotency-Key, \"none\" for no key)", secret: false },
    }),
    actions: [
      {
        id: "request",
        label: "HTTP request",
        description:
          "Make any HTTP request. The body is the rendered template (or the event payload). Args: method, url (absolute or relative to base_url), headers (JSON), query (JSON).",
        argsSchema: {
          method: { label: "Method (GET/POST/PUT/PATCH/DELETE)", type: "text" },
          url: { label: "URL (absolute or path)", type: "text" },
          headers: { label: "Headers (JSON object)", type: "text" },
          query: { label: "Query params (JSON object)", type: "text" },
        },
      },
    ],
    invoke: async (ctx, actionId) => {
      if (actionId !== "request") throw new Error(`http: unknown action ${actionId}`);
      const args = ctx.args ?? {};
      const method = (String(args.method ?? "POST").toUpperCase() || "POST") as string;

      // Resolve the URL: absolute arg wins, else base_url + relative path.
      const rawUrl = String(args.url ?? "");
      const base = String(ctx.credentials.base_url ?? "");
      let target = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${base.replace(/\/$/, "")}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
      if (!target) throw new Error("http: no URL configured");

      const query = parseJsonObject(args.query);
      const qs = new URLSearchParams(query).toString();
      if (qs) target += (target.includes("?") ? "&" : "?") + qs;

      await assertSafeOutboundUrl(target);

      const headers: Record<string, string> = {
        "user-agent": "cobblr-integrations/0.1",
        ...parseJsonObject(args.headers),
      };
      const bearer = ctx.credentials.bearer_token;
      if (typeof bearer === "string" && bearer && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        // The saved token belongs to the connection's own address. A member who
        // may run the connection can name any URL, so a token goes only where the
        // connection points: another origin is refused, not sent without it.
        const own = originOf(base);
        if (!own) throw new Error("http: this connection has a token but no base address for it to belong to; set the base URL");
        if (originOf(target) !== own) throw new Error(`http: this connection's token is for ${own} and cannot be sent to another address`);
        headers.authorization = `Bearer ${bearer}`;
      }

      const hasBody = method !== "GET" && method !== "HEAD";
      let body: string | undefined;
      if (hasBody) {
        body = ctx.rendered ?? JSON.stringify(ctx.event?.payload ?? ctx.args ?? {});
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      }

      const keyHeader = idempotencyHeaderOf(ctx.credentials);
      if (keyHeader && ctx.idempotencyKey && !Object.keys(headers).some((k) => k.toLowerCase() === keyHeader.toLowerCase())) headers[keyHeader] = ctx.idempotencyKey;
      const res = await sendFetch("http", target, { method, headers, body }, keyHeader);
      const text = await res.text().catch(() => "");
      return { status: res.status, body: text.slice(0, 2000) };
    },
    testConnection: async (credentials) => {
      const base = String(credentials.base_url ?? "");
      if (!base) return { ok: true }; // base_url is optional; nothing to test
      try {
        await assertSafeOutboundUrl(base);
        const res = await safeFetch(base, { method: "HEAD" }, 8_000).catch(() => safeFetch(base, { method: "GET" }, 8_000));
        return { ok: res.ok || res.status < 500 };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  });
}
