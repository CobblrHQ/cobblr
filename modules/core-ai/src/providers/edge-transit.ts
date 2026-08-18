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
//     bridge via transit value "bridge:<id>" (same channel key format as
//     digifab — kept local, module isolation).

import { platform } from "@cobblr/platform-contract";
import type { AiCredentialField } from "@cobblr/platform-contract";

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
  return String(credentials.transit ?? "").startsWith("bridge");
}

/** Channel key for the bridge transit. orgId comes from invoke ctx; the test
 *  route injects __org_id instead (testConnection gets no ctx). */
export function edgeKeyFor(credentials: Record<string, unknown>, orgId?: string): string {
  const owner = typeof credentials.__connection_user_id === "string" ? credentials.__connection_user_id : "";
  if (owner) return owner;
  const org = orgId || (typeof credentials.__org_id === "string" ? credentials.__org_id : "");
  if (!org) throw new Error("edge transit: no routing context (personal owner or workspace) available");
  const t = String(credentials.transit ?? "");
  const name = t.startsWith("bridge:") ? t.slice("bridge:".length).slice(0, 60) : "";
  return name ? `${org}::${name}` : org;
}

// The bridge long-polls; between poll cycles the channel can be momentarily
// unregistered, so send() throws "no edge device connected". Transient — the
// agent re-polls within seconds (same lesson as the edge-bridge provider).
const RECONNECTING = /no edge device|edge disconnected|edge channel gone/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fetch-shaped call through the edge relay: the bridge performs
 *  `baseUrl + path` on its LAN and the JSON result rides back up. */
export async function edgeFetch(
  key: string,
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  // Providers pass the same JSON string they'd hand fetch(); the relay carries
  // structured bodies, so parse it back rather than double-encoding.
  const body = typeof init.body === "string" ? safeParse(init.body) : init.body;
  const req = {
    path,
    method: (init.method ?? "GET") as "GET" | "POST",
    ...(body !== undefined && body !== null ? { body } : {}),
    source: { baseUrl: baseUrl.replace(/\/+$/, ""), headers: init.headers ?? {} },
    timeoutMs: 120_000, // local models can be slow — same budget as a direct call
  };
  let res;
  try {
    res = await platform().edge.send(key, req);
  } catch (err) {
    if (!RECONNECTING.test((err as Error).message ?? "")) throw err;
    await sleep(1500);
    res = await platform().edge.send(key, req);
  }
  // Binary responses ride as { __binary, contentType, data_b64 } (the JSON
  // relay can't carry raw bytes) — reconstruct so res.arrayBuffer() works.
  const b = res.body as { __binary?: boolean; contentType?: string; data_b64?: string } | null;
  if (b && b.__binary === true && typeof b.data_b64 === "string") {
    const bytes = Uint8Array.from(Buffer.from(b.data_b64, "base64"));
    return new Response(bytes, {
      status: res.status || 502,
      headers: { "content-type": b.contentType || "application/octet-stream" },
    });
  }
  const bodyText = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? null);
  const status = res.status || 502;
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
