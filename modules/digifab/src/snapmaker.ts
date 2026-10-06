import { platform } from "@cobblr/platform-contract";
import { edgeChannelKey } from "@cobblr/platform-contract/edge-channel";
import { edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";
import { z } from "zod";
import { buildEdgeRelay } from "./jobs-core.js";

export const FoundSnapmaker = z.object({ name: z.string().max(120), host: z.string().ip({ version: "v4" }), model: z.string().max(120), transport: z.enum(["http", "sacp"]) });

export async function discoverSnapmakers(orgId: string, bridge: string | null) {
  const id = "snapmaker-discovery";
  const result = await platform().edge.send(edgeChannelKey(orgId, bridge), { method: "GET", path: `/${id}/discover`, instance: { id, driver: "snapmaker", config: { host: "discovery" } } });
  if (result.status >= 400) throw new Error("The bridge could not discover Snapmakers. Check that it is online and on the machines' LAN.");
  return z.object({ items: z.array(FoundSnapmaker).max(256) }).parse(result.body);
}

export async function pairSnapmaker(orgId: string, connectionId: string): Promise<{ state: "waiting" | "paired" }> {
  const store = platform().devices.connections();
  const row = await store.getInternal(orgId, connectionId);
  if (!row || row.type !== "edge_adapter" || !row.credentials_enc) throw new Error("Choose a Snapmaker bridge connection to pair.");
  const credentials = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  const edge = credentials.edge as Record<string, unknown> | undefined;
  if (edge?.driver !== "snapmaker" || !edgeInstanceOf(row.base_url)) throw new Error("Choose a Snapmaker bridge connection to pair.");
  const { token: _token, ...pairConfig } = edge;
  const id = `snapmaker-pair-${connectionId}`;
  const relay = buildEdgeRelay(orgId, `cobblr-edge://${id}`, pairConfig);
  if (!relay) throw new Error("Choose a Snapmaker on your LAN bridge to pair.");
  const response = await relay({ method: "POST", path: `/${id}/pair` });
  if (response.status >= 400) throw new Error("Snapmaker pairing was declined or unavailable. Check its screen and disconnect Luban, then try again.");
  const result = z.object({ state: z.enum(["waiting", "paired"]), token: z.string().min(1).max(500).optional() }).parse(response.body);
  if (result.state === "waiting") return { state: "waiting" };
  if (!result.token) throw new Error("Snapmaker approval did not return a token. Pair again on its screen.");
  await store.update(orgId, connectionId, { creds: { ...credentials, edge: { ...edge, token: result.token } } });
  return { state: "paired" };
}

let registered = false;
export function registerSnapmakerDiscovery(): void {
  if (registered) return;
  registered = true;
  platform().actions.registerHandler("digifab.discover-snapmakers", async ctx => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Finding Snapmakers requires an admin." };
    const bridge = z.string().trim().min(1).max(60).nullable().parse(ctx.args?.bridge || null);
    return { ok: true, ...await discoverSnapmakers(ctx.orgId, bridge) };
  });
}
