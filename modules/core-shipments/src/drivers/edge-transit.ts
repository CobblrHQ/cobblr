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
import { parseTransit } from "./connection.js";

/** The bridge long-polls, so between cycles the channel is briefly
 *  unregistered and send() throws. Transient: the agent re-polls in seconds. */
const RECONNECTING = /no edge device|edge disconnected|edge channel gone/i;

/** How to reach the endpoint.
 *    ""            unset — fetch it directly (a public API)
 *    "bridge"      the caller's own bridge: personal if they have one, else
 *                  the workspace's
 *    "bridge:<id>" a named workspace bridge, when there is more than one */
export function transitMode(): { viaBridge: boolean; named: string } {
  // ONE parser, in connection.ts. The identical setting arrives either from the
  // environment or from a personal connection, and two copies of "what does
  // bridge:x mean" is precisely the pair that drifts.
  // `||` not `??`: compose passes an unset var as "" (CLAUDE.md section 14.6).
  return parseTransit(process.env.COBBLR_TRACKING_API_TRANSIT || "");
}

/** Which edge channel to route down.
 *
 *  PERSONAL FIRST, exactly as the AI transit does it, and for a better reason
 *  here than there: parcels belong to a PERSON, not a workspace. Somebody's
 *  packages arrive whichever workspace they end up filed in, so one bridge of
 *  theirs should serve all of them rather than needing one per workspace.
 *
 *  Precedence, and each rung is a real deployment:
 *    owner   a personal bridge (/me/connections) — one agent, every workspace
 *            its owner routes it to. The same shape as their local-AI bridge.
 *    org     a workspace bridge, for a shared site rather than a person.
 *    named   `org::<id>` when a workspace runs more than one.
 *
 *  Same key format as the AI transit and digifab, so a bridge is addressed one
 *  way everywhere. */
export function edgeKeyFor(orgId: string, named: string, ownerUserId?: string | null): string {
  const owner = (ownerUserId ?? "").trim();
  if (owner) return owner;
  if (!orgId) {
    throw new Error("edge transit: no personal owner or workspace to route to a bridge");
  }
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
