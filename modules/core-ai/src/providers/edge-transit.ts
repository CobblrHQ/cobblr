// Edge transit for URL-based AI providers (ollama, openai-compat). A hosted
// Cobblr can't fetch a LAN endpoint (SSRF policy + NAT), so a provider whose
// endpoint is local to the user offers a `transit` choice: direct fetch (the
// default — public URL or self-hosted same-network), or ride the user's
// dial-out edge bridge, where the bridge performs the HTTP call on its LAN and
// returns the result (EdgeRequest.source — the same generic proxy sync
// connectors use; the cloud never touches the private address).
//
// Which bridge? Derived, never configured twice:
//   · a PERSONAL connection (/me/connections) carries __connection_user_id →
//     the owner's personal agent (one agent, all their workspaces);
//   · a WORKSPACE provider (AI settings) → the workspace's bridge; a named
//     bridge via transit value "bridge:<id>". The key itself comes from
//     @cobblr/platform-contract/edge-channel, the one derivation every door
//     and sender shares.

import { platform } from "@cobblr/platform-contract";
import type { AiCredentialField } from "@cobblr/platform-contract";
import { edgeRouteKey, edgeTransit } from "@cobblr/platform-contract/edge-channel";

/** Spread into describeCredentials() of any provider whose endpoint can be
 *  local to the user. Renders as a select in every credential form. */
export const TRANSIT_FIELD: Record<string, AiCredentialField> = {
  transit: {
    label: "How Cobblr reaches it",
    secret: false,
    choices: [
      { value: "", label: "Direct: the URL is reachable from this Cobblr (public URL, or self-hosted on the same network)" },
      { value: "bridge", label: "Via my edge bridge: it runs on my own machine / LAN" },
    ],
  },
};

export function viaBridge(credentials: Record<string, unknown>): boolean {
  return edgeTransit(credentials.transit).viaBridge;
}

/** Channel key for the bridge transit. orgId comes from invoke ctx; the test
 *  route injects __org_id instead (testConnection gets no ctx). */
export function edgeKeyFor(credentials: Record<string, unknown>, orgId?: string): string {
  return edgeRouteKey({
    ownerUserId: credentials.__connection_user_id,
    orgId: orgId || credentials.__org_id,
    bridge: edgeTransit(credentials.transit).bridge,
  });
}

/** Fetch-shaped call through the edge relay: the bridge performs
 *  `baseUrl + path` on its LAN and the result rides back up. The transport is
 *  the platform's (`platform().edge.fetch`); what is AI-specific is the error
 *  envelope below. */
export async function edgeFetch(
  key: string,
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; privacy?: "personal" | "normal"; requiredFeatures?: readonly string[] },
): Promise<Response> {
  // Providers pass the same JSON string they'd hand fetch(); the relay carries
  // structured bodies, so parse it back rather than double-encoding.
  const body = typeof init.body === "string" ? safeParse(init.body) : init.body;
  const res = await platform().edge.fetch(key, {
    baseUrl,
    path,
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(body !== undefined && body !== null ? { body } : {}),
    timeoutMs: 120_000, // local models can be slow — same budget as a direct call
    lane: "ai",
    ...(init.privacy ? { privacy: init.privacy } : {}),
    ...(init.requiredFeatures ? { requiredFeatures: init.requiredFeatures } : {}),
  });
  const ctype = res.headers.get("content-type") ?? "";
  if (!/json|^text\//.test(ctype) && res.body !== null && ctype) return res; // binary rides through as bytes
  const bodyText = await res.text();
  const status = res.status;
  // The edge target's body rides through verbatim, and it is NOT always JSON —
  // a gateway in front of it answers "Bad Gateway" in plain text, and a relay
  // that gave up answers with a bare note. Declaring `application/json` over
  // that makes every caller fail at JSON.parse and report the parse failure
  // instead of the reason, which is how a relay timeout surfaced to a user as
  // "Non-JSON response (502)" with the real message nowhere (2026-08-18).
  // So: pass real JSON through untouched, and wrap anything else in an error
  // envelope that says the same thing in a shape callers can actually read.
  const payload = isJsonText(bodyText)
    ? bodyText
    : JSON.stringify({
        error: {
          code: "edge_relay",
          message:
            bodyText.trim().slice(0, 300) ||
            `the edge relay returned ${status} with no body`,
        },
      });
  return new Response(payload, { status, headers: { "content-type": "application/json" } });
}

function isJsonText(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
