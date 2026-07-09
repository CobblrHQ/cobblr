// Live status of the user's PERSONAL edge bridge (the local-AI tunnel that
// routes bridge-transit connections to their LAN). Same liveness source the
// device/digifab bridges use — platform().edge.hasChannel(userId), exposed as
// GET /me/edge-agent — just keyed by user instead of org. Reconciles the two:
// one registry, queried by whichever key applies.
//
// `hasBridge` gates the indicator so users who don't run a personal bridge
// never see an "offline" dot. Shares the ["connections"] + ["me-edge-agent"]
// query keys with ConnectionsPage so nothing double-fetches.

import { useQuery } from "@tanstack/react-query";
import { api, type UserConnection } from "./api";

/** True when a connection depends on the personal edge agent: the dedicated
 *  edge-bridge provider, OR any URL provider whose transit rides the bridge
 *  (the server computes `uses_edge` from the encrypted bag — a boolean, never
 *  the values). The provider_id check keeps this correct against a cached
 *  response from an older API that lacks the flag. */
export function isEdgeBridgeConnection(c: Pick<UserConnection, "provider_id" | "uses_edge">): boolean {
  return c.uses_edge === true || c.provider_id === "edge-bridge";
}

export interface MyEdgeBridge {
  /** The user has at least one edge-dependent connection (so the status matters). */
  hasBridge: boolean;
  /** The personal edge agent is currently dialed in. */
  connected: boolean;
}

export function useMyEdgeBridge(): MyEdgeBridge {
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const hasBridge = (conns.data?.items ?? []).some(isEdgeBridgeConnection);
  const agent = useQuery({
    queryKey: ["me-edge-agent"],
    queryFn: api.getMyEdgeAgent,
    enabled: hasBridge,
    refetchInterval: hasBridge ? 5000 : false,
  });
  return { hasBridge, connected: agent.data?.connected ?? false };
}
