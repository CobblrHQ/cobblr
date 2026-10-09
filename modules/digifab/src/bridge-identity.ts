import {createHash} from "node:crypto";
import {bridgeDiscoveryIdentity} from "@cobblr/platform-contract/bridge-discovery";
import { platform } from "@cobblr/platform-contract";
export function publicBridgeConfig(value: Record<string, unknown>) {
  return { driver: typeof value.driver === "string" ? value.driver : null, bridge: typeof value.bridge === "string" ? value.bridge : null };
}
export async function readBridgeConfig(orgId: string, connectionId: string) {
  const row = await platform().devices.connections().getInternal(orgId, connectionId);
  const credentials = row?.credentials_enc ? await platform().integrations.decryptCredentials(orgId, row.credentials_enc) : {};
  const config=(credentials.edge || {}) as Record<string,unknown>;
  const identity=bridgeDiscoveryIdentity(config);
  return {...publicBridgeConfig(config),...(identity?{discovery_key:createHash("sha256").update(identity).digest("hex")}: {})};
}
