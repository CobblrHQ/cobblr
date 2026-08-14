// Reaching a tracking endpoint that lives on the user's own network.
//
// A hosted Cobblr cannot fetch a LAN address: the egress policy blocks private
// targets, and NAT would stop it anyway. So an endpoint local to the user rides
// their dial-out edge bridge instead — the bridge performs the HTTP call on its
// LAN and the result comes back up the relay.
//
// The relay is a GENERIC proxy: the request carries `source.baseUrl`, so the
// bridge is told what to fetch rather than configured per service. Nothing has
// to be added to the bridge for shipments to work through it.
//
// ⚠️ SECOND COPY. core-ai/src/providers/edge-transit.ts does the same thing for
// AI providers, and module isolation forbids importing it. If a third module
// needs this, promote it to the platform rather than copying again.

import { platform } from "@cobblr/platform-contract";

/** The bridge long-polls, so between cycles the channel is briefly
 *  unregistered and send() throws. Transient: the agent re-polls in seconds. */
const RECONNECTING = /no edge device|edge disconnected|edge channel gone/i;

/** "" or unset = fetch it directly. "bridge" = the workspace's bridge.
 *  "bridge:<id>" = a named one, for a workspace running more than one. */
export function transitMode(): { viaBridge: boolean; named: string } {
  // `||` not `??`: compose passes an unset var as "" (CLAUDE.md section 14.6).
  const t = (process.env.COBBLR_TRACKING_API_TRANSIT || "").trim();
  if (!t.startsWith("bridge")) return { viaBridge: false, named: "" };
  return { viaBridge: true, named: t.startsWith("bridge:") ? t.slice(7).slice(0, 60) : "" };
}

/** Which edge channel to route down. Same key format as the AI transit and
 *  digifab, so a workspace's bridges are addressed one way everywhere. */
export function edgeKeyFor(orgId: string, named: string): string {
  if (!orgId) throw new Error("edge transit: no workspace context to route to a bridge");
  return named ? `${orgId}::${named}` : orgId;
}

/** fetch-shaped, but performed by the bridge on its own network. */
export async function edgeFetch(
  key: string,
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string> } = {},
): Promise<Response> {
  const req = {
    path,
    method: (init.method ?? "GET") as "GET" | "POST",
    source: { baseUrl: baseUrl.replace(/\/+$/, ""), headers: init.headers ?? {} },
    timeoutMs: 60_000,
  };

  let res;
  try {
    res = await platform().edge.send(key, req);
  } catch (err) {
    if (!RECONNECTING.test((err as Error).message ?? "")) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    res = await platform().edge.send(key, req);
  }

  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body ?? null);
  return new Response(text, {
    status: res.status || 502,
    headers: { "content-type": "application/json" },
  });
}
