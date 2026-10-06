import {z} from "zod";
import {platform} from "@cobblr/platform-contract";
import {normaliseActionResult} from "@cobblr/platform-contract/action-result";
import {ReviewRequired} from "./drivers/job-review.js";
export const CutterRollSchema=z.object({id:z.string().uuid(),name:z.string(),kind:z.string(),instance:z.string(),shape:z.literal("roll"),unit:z.literal("m"),remaining:z.number().finite().nonnegative(),revision:z.number().int().nonnegative(),config:z.object({shape:z.literal("roll"),width_mm:z.number().finite().positive(),waste:z.number().finite().nonnegative()})});
export type CutterRoll=z.infer<typeof CutterRollSchema>;
const pageSchema=z.object({items:z.array(CutterRollSchema),complete:z.boolean(),loaded:z.array(z.object({part_id:z.string().uuid(),station:z.string(),slot:z.string()}))});
export const cutterStationKey=(connectionId:string,deviceId:string)=>`digifab:${connectionId}:${deviceId}`;
export async function cutterStock(orgId:string,connectionId:string,deviceId:string,userId:string|null=null) {
 const items:CutterRoll[]=[];let loaded:z.infer<typeof pageSchema>["loaded"]=[];
 for(let offset=0;offset<100000;offset+=200) {
  const out=normaliseActionResult(await platform().actions.invoke("inventory:list-stock",{orgId,userId,entity:{kind:"digifab:connection",id:connectionId},args:{fields:{shape:"roll",station:cutterStationKey(connectionId,deviceId),limit:200,offset}},event:{name:null,payload:{},actor:{user_id:userId,display_name:null,auth_method:"session"},timestamp:new Date().toISOString(),trigger_type:"user-invoked"}}),"inventory:list-stock");
  if(!out.ok)throw new ReviewRequired("The roll stock could not be read. Check Inventory before starting.");
  const page=pageSchema.parse(out.data);items.push(...page.items);loaded=page.loaded;
  if(page.complete)return {items,loaded};
  if(!page.items.length)throw new ReviewRequired("Inventory returned an incomplete roll list.");
 }
 throw new ReviewRequired("Narrow the roll list before preparing this cut.");
}
export async function currentCutterRoll(orgId:string,connectionId:string,deviceId:string,id:string,requireLoaded=false,allowEmpty=false):Promise<CutterRoll> {
 const stock=await cutterStock(orgId,connectionId,deviceId),roll=stock.items.find(r=>r.id===id);
 if(!roll || !allowEmpty && roll.remaining<=0)throw new ReviewRequired("Choose an available roll from Inventory.");
 if(requireLoaded && !stock.loaded.some(l=>l.part_id===id&&l.station===cutterStationKey(connectionId,deviceId)&&l.slot==="stock"))throw new ReviewRequired("Load the chosen roll at this cutter's station before Start.");
 return roll;
}
export function cutterRollMismatch(expected:CutterRoll,actual:CutterRoll,lengthM:number):string|null {
 if(expected.id!==actual.id||expected.kind!==actual.kind||expected.instance!==actual.instance)return "Load the roll chosen for this plan.";
 if(expected.revision!==actual.revision||expected.config.width_mm!==actual.config.width_mm||expected.config.waste!==actual.config.waste)return "This roll changed after planning. Prepare a new cutter plan.";
 if(lengthM+actual.config.waste>actual.remaining)return "The loaded roll does not have enough length for this cut and waste.";
 return null;
}
