// How a bridge is addressed: one derivation of the edge channel key, for the
// side that registers a bridge and every side that sends to one.
//
// The key is `<orgId>` for a workspace's default bridge, `<orgId>::<name>` for a
// named one, and the owner's user id for a personal bridge (one bridge serving
// all of a person's workspaces). It was derived in seven places: the kernel's
// relay door and presence read, digifab's relay alias and its job sender,
// core-print, core-integrations' sync fetch, the AI and shipments transits. The
// receiving doors capped a bridge name at 60 characters; core-print's sender
// trimmed it and did not cap, and the rest did neither. A bridge whose name ran
// past 60 characters, or carried a space, registered on one key and was sent to
// on another, and a send to a channel nobody holds reads exactly like a bridge
// that is offline (#3421, #3499).
//
// Every door now derives the key here, so the name is normalised the same way
// on both ends of the wire.

/** The longest bridge name a key carries; longer names are cut, the same way on
 *  every side. */
export const EDGE_BRIDGE_NAME_MAX = 60;

/** A bridge name as it appears in a key: trimmed, capped, or null for the
 *  workspace's default bridge. Accepts whatever a query string or a setting
 *  hands over. */
export function edgeBridgeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, EDGE_BRIDGE_NAME_MAX).trim();
  return name || null;
}

/** A workspace bridge's channel key: `<orgId>`, or `<orgId>::<name>`. */
export function edgeChannelKey(orgId: string, bridge?: unknown): string {
  const name = edgeBridgeName(bridge);
  return name ? `${orgId}::${name}` : orgId;
}

/** A transit setting shared by connections that can go through a bridge:
 *  "" or absent means direct, "bridge" the default bridge, "bridge:<name>" a
 *  named one. */
export function edgeTransit(raw: unknown): { viaBridge: boolean; bridge: string | null } {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t.startsWith("bridge")) return { viaBridge: false, bridge: null };
  return { viaBridge: true, bridge: t.startsWith("bridge:") ? edgeBridgeName(t.slice("bridge:".length)) : null };
}

/** The key a send routes to: the owner's personal bridge when the connection
 *  belongs to a person, else the workspace's (default or named). Throws when
 *  there is neither, because a send with no route cannot be answered. */
export function edgeRouteKey(route: { ownerUserId?: unknown; orgId?: unknown; bridge?: unknown }): string {
  const owner = typeof route.ownerUserId === "string" ? route.ownerUserId.trim() : "";
  if (owner) return owner;
  const org = typeof route.orgId === "string" ? route.orgId : "";
  if (!org) throw new Error("edge: no personal owner or workspace to route to a bridge");
  return edgeChannelKey(org, route.bridge);
}
