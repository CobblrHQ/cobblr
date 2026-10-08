import { platform } from "@cobblr/platform-contract";
import { edgeChannelKey } from "@cobblr/platform-contract/edge-channel";
import { z } from "zod";
const FoundESPHome=z.object({name:z.string().max(120),host:z.string().min(1).max(253),port:z.number().int().min(1).max(65535)}).strict();
export async function discoverBenchESPHome(orgId:string,bridge:string|null){
 const id="bench-esphome-discovery";
 const result=await platform().edge.send(edgeChannelKey(orgId,bridge),{method:"POST",path:`/${id}/command`,body:{command:"discover",params:{}},instance:{id,driver:"esphome",config:{}}});
 if(result.status>=400)throw new Error("The bridge could not discover ESPHome devices. Check its connection and network.");
 const reply=z.object({ok:z.literal(true),data:z.object({devices:z.array(FoundESPHome).max(256)})}).parse(result.body);
 return {items:reply.data.devices};
}
