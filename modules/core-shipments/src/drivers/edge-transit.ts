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
// The call itself is the platform's (`platform().edge.fetch`), the one copy
// every module reaches a LAN service through.

import { platform } from "@cobblr/platform-contract";
import { parseTransit } from "./connection.js";
import { edgeRouteKey } from "@cobblr/platform-contract/edge-channel";

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
  return edgeRouteKey({ ownerUserId, orgId, bridge: named });
}

/** fetch-shaped, but performed by the bridge on its own network. */
export function edgeFetch(
  key: string,
  baseUrl: string,
  path: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string> } = {},
): Promise<Response> {
  return platform().edge.fetch(key, { baseUrl, path, method: init.method ?? "GET", headers: init.headers ?? {}, timeoutMs: 60_000, lane: "sync" });
}
