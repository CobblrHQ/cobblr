import { platform, type DeviceConnectionInternal } from "@cobblr/platform-contract";
import { edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";
import { edgeChannelKey } from "@cobblr/platform-contract/edge-channel";

export async function releaseRemovedConnection(orgId: string, row: DeviceConnectionInternal): Promise<void> {
  const instance = edgeInstanceOf(row.base_url);
  if (row.type !== "edge_adapter" || !instance) return;
  try {
    const credentials = row.credentials_enc
      ? await platform().integrations.decryptCredentials(orgId, row.credentials_enc)
      : {};
    // Removing a borrowed connection must not close the owner's controller.
    if (credentials.shared) return;
    const edge = credentials.edge as { bridge?: unknown } | undefined;
    const bridge = typeof edge?.bridge === "string" ? edge.bridge : null;
    await platform().edge.send(edgeChannelKey(orgId, bridge), {
      method: "POST",
      lane: "control",
      path: `/instances/${encodeURIComponent(instance)}/release`,
      timeoutMs: 5000,
    });
  } catch {
    console.warn("[core-devices] Bridge release failed after removing a connection; its idle expiry will release it.");
  }
}
