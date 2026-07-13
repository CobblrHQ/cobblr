// The cloud→edge relay wiring for core-print. Kept OUT of the pure driver
// (drivers/edge-print.ts) so that stays platform-free + unit-testable — this is
// the one place that touches platform().edge, mirroring how digifab builds its
// relay in jobs-core.ts (not inside the driver).

import { platform } from "@cobblr/platform-contract";
import type { EdgeRelay } from "./drivers/edge-print.js";

/** True for a `cobblr-edge://…` manager URL — the printer's manager lives on the
 *  user's LAN behind an edge bridge, not at a directly-reachable address. */
export function isEdgeManagerUrl(baseUrl: string): boolean {
  return /^cobblr-edge:/i.test(baseUrl);
}

/** The bridge id encoded in `cobblr-edge://<bridge-id>` (empty → the workspace's
 *  default bridge). */
export function bridgeIdOf(baseUrl: string): string | null {
  if (!isEdgeManagerUrl(baseUrl)) return null;
  const raw = (/^cobblr-edge:\/\/(.*)$/i.exec(baseUrl)?.[1] ?? "").replace(/^\/+|\/+$/g, "");
  return raw || null;
}

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
export function buildEdgeRelay(orgId: string, baseUrl: string): EdgeRelay | null {
  if (!isEdgeManagerUrl(baseUrl)) return null;
  const key = edgeChannelKey(orgId, bridgeIdOf(baseUrl));
  return async (r) => {
    const res = await platform().edge.send(key, { path: r.path, method: r.method, body: r.body });
    return { status: res.status, body: res.body };
  };
}
