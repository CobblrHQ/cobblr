// The cloud→edge relay wiring for core-print. Kept OUT of the pure driver
// (drivers/edge-print.ts) so that stays platform-free + unit-testable — this is
// the one place that touches platform().edge, mirroring how digifab builds its
// relay in jobs-core.ts (not inside the driver).

import { platform } from "@cobblr/platform-contract";
import type { EdgeRelay } from "./drivers/edge-print.js";

/** True for a `cobblr-edge://…` manager URL — the printer's manager lives on the
 *  user's LAN behind an edge bridge, not at a directly-reachable address.
 *  One definition, beside the protocol: this regex had drifted into three
 *  copies, and the UI needed a fourth to tell a bridged printer from a network
 *  one. */
import { isEdgeManagerUrl } from "@cobblr/platform-contract/edge-bridge-client";
export { isEdgeManagerUrl };

// NOTE the identifier convention CHANGED with the contract fix. `cobblr-edge://
// <id>` now names the INSTANCE on the bridge (matching digifab), not the bridge.
// WHICH bridge — the tunnel channel — is settings.bridge.bridgeName, unset
// meaning the workspace default. The old reading (URL id = bridge) never carried
// a working deployment: the driver spoke paths no bridge implements, so nothing
// could have been printing that depends on it. Reusing one id for both meanings
// would route cobblr-edge://labels to a channel for a bridge NAMED "labels".

/** The kernel edge-channel key convention (documented on PlatformEdge): `orgId`
 *  for the default bridge, `orgId::<name>` for a named one. Inlined (not imported
 *  from digifab) so core-print stays module-isolated. */
function edgeChannelKey(orgId: string, bridge: string | null): string {
  return bridge ? `${orgId}::${bridge}` : orgId;
}

/** Build the relay closure for a `cobblr-edge://` manager URL — every bridge call
 *  routes through the org's live edge channel (platform().edge.send), so the
 *  cloud never touches a private IP. Null for a direct `http(s)://` manager (that
 *  path dials CUPS directly and stays under the SSRF guard). */
export function buildEdgeRelay(orgId: string, baseUrl: string, bridgeName?: string | null): EdgeRelay | null {
  if (!isEdgeManagerUrl(baseUrl)) return null;
  const key = edgeChannelKey(orgId, bridgeName?.trim() || null);
  return async (r) => {
    const res = await platform().edge.send(key, { path: r.path, method: r.method, body: r.body });
    return { status: res.status, body: res.body };
  };
}
