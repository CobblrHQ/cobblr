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
import { api } from "./api";

/** True when a connection routes through the personal edge bridge. Today that's
 *  the dedicated "Local AI (via edge bridge)" provider. */
export function isEdgeBridgeConnection(providerId: string): boolean {
  return providerId === "edge-bridge";
}

export interface MyEdgeBridge {
  /** The user has at least one edge-bridge connection (so the status matters). */
  hasBridge: boolean;
  /** The personal edge agent is currently dialed in. */
  connected: boolean;
}

export function useMyEdgeBridge(): MyEdgeBridge {
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const hasBridge = (conns.data?.items ?? []).some((c) => isEdgeBridgeConnection(c.provider_id));
  const agent = useQuery({
    queryKey: ["me-edge-agent"],
    queryFn: api.getMyEdgeAgent,
    enabled: hasBridge,
    refetchInterval: hasBridge ? 5000 : false,
  });
  return { hasBridge, connected: agent.data?.connected ?? false };
}
