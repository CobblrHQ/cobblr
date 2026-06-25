// Edge transport for sync connectors. Instead of the cloud fetching the source
// directly (impossible to a LAN address on a hosted instance), the connector's
// fetch is translated into an EdgeRequest and sent down the workspace's dial-out
// relay: a local bridge performs the HTTP call against the source on the LAN and
// returns the result. The cloud never touches the private address.

import { platform, type EdgeRequest } from "@cobblr/platform-contract";
import type { SyncConnectionRef } from "./engine.js";

// Same format as digifab's edgeChannelKey (modules/digifab/jobs-core.ts) so a
// single bridge per workspace can serve both machines and sync sources. Kept
// local rather than cross-importing digifab (module isolation).
function channelKey(orgId: string, bridge: string | null): string {
  return bridge ? `${orgId}::${bridge}` : orgId;
}

function headersToObject(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(h)) {
    for (const pair of h) if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
  } else if (typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

/** A `fetch`-shaped function that proxies through the edge relay for this ref. */
export function edgeRelayFetch(ref: SyncConnectionRef): typeof fetch {
  const key = channelKey(ref.orgId, ref.bridge);
  return (async (input, init) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    // Path relative to the source base (the bridge re-joins baseUrl + path).
    const path = href.startsWith(ref.baseUrl)
      ? href.slice(ref.baseUrl.length) || "/"
      : (() => {
          const u = new URL(href);
          return u.pathname + u.search;
        })();
    const method = (init?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const req: EdgeRequest = {
      path,
      method,
      ...(init?.body !== undefined && init?.body !== null
        ? { body: typeof init.body === "string" ? safeParse(init.body) : init.body }
        : {}),
      source: { baseUrl: ref.baseUrl, headers: headersToObject(init?.headers) },
    };
    const res = await platform().edge.send(key, req);
    // Binary responses (images, files) ride as { __binary, contentType, data_b64 }
    // because the JSON relay can't carry raw bytes — the bridge base64-encodes any
    // non-text body. Reconstruct a real binary Response so res.arrayBuffer() works.
    const b = res.body as { __binary?: boolean; contentType?: string; data_b64?: string } | null;
    if (b && b.__binary === true && typeof b.data_b64 === "string") {
      const bytes = Uint8Array.from(Buffer.from(b.data_b64, "base64"));
      return new Response(bytes, {
        status: res.status || 502,
        headers: { "content-type": b.contentType || "application/octet-stream" },
      });
    }
    const bodyText = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? null);
    return new Response(bodyText, {
      status: res.status || 502,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
