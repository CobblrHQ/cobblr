// Bringing one of your own AI connections into the workspace you are looking
// at, from that workspace's AI page, in one click.
//
// The route existed - Off / Just me / Share, per workspace, on /me/connections
// - but from the workspace side there was no way to reach it: the page told
// you to go to your connections, find the one you meant, find this workspace
// in its list, pick a mode, save, come back. "Use here" and "Share" are those
// same two modes, pressed from where the decision is actually being made.
//
// Share by the workspace's owner is approved on the spot (the platform already
// does that); by anyone else it is an offer the owner sees on this page.

import type { ConnRoute, UserConnection } from "./api";

/** Your AI connections with no route into this workspace yet. */
export function connectionsNotUsedIn(orgId: string, mine: UserConnection[]): UserConnection[] {
  return mine.filter((c) => c.kind === "ai-provider" && !c.routes.some((r) => r.org_id === orgId));
}

/** The connection's routes with this workspace added (or its mode replaced). */
export function routesWith(routes: ConnRoute[], orgId: string, mode: ConnRoute["mode"]): ConnRoute[] {
  return [...routes.filter((r) => r.org_id !== orgId), { org_id: orgId, mode }];
}
