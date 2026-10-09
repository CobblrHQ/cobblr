import {z} from "zod";
export const SERVER_BRIDGE_ID="cobblr-server";
export interface ServerBridgeState {
 available:boolean;
 enabled:boolean;
 reason:"cloud"|"not_configured"|null;
 bridge:typeof SERVER_BRIDGE_ID;
}

export const ServerBridgeConfig=z.object({
 orgId:z.string().uuid(),
 tokenId:z.string().uuid(),
 relay:z.string().url().refine(value=>{const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/api\/v1\/orgs\/[a-z0-9-]+\/edge$/.test(url.pathname);}),
 token:z.string().min(1).max(256),
 bridge:z.literal(SERVER_BRIDGE_ID),
}).strict();
export type WorkspaceBridgeConfig=z.infer<typeof ServerBridgeConfig>;
