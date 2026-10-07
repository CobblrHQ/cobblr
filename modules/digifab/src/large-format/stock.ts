import {z} from "zod";
import {platform} from "@cobblr/platform-contract";
import {normaliseActionResult} from "@cobblr/platform-contract/action-result";
import {cutterStationKey} from "../cutter-stock.js";
import {ReviewRequired} from "../drivers/job-review.js";
export const InkStock=z.object({id:z.string().uuid(),kind:z.string(),name:z.string(),revision:z.number().int().nonnegative(),shape:z.literal("liquid"),unit:z.literal("ml")});
export type LoadedInk=z.infer<typeof InkStock>&{slot:string};
export async function loadedInk(orgId:string,connectionId:string,deviceId:string):Promise<LoadedInk[]> {
 const stock:z.infer<typeof InkStock>[]=[],station=cutterStationKey(connectionId,deviceId);
 for(let offset=0;offset<100000;offset+=200) {
  const out=normaliseActionResult(await platform().actions.invoke("inventory:list-stock",{orgId,userId:null,args:{fields:{shape:"liquid",station,limit:200,offset}},event:{name:null,payload:{},actor:{user_id:null,display_name:null,auth_method:"session"},timestamp:new Date().toISOString(),trigger_type:"user-invoked"}}),"inventory:list-stock");
  if(!out.ok)throw new ReviewRequired("The ink stock could not be read. Check Inventory.");
  const page=z.object({items:z.array(InkStock),complete:z.boolean(),loaded:z.array(z.object({part_id:z.string().uuid(),slot:z.string(),station:z.string()}))}).parse(out.data);stock.push(...page.items);
  if(page.complete)return page.loaded.filter(i=>i.station===station&&i.slot.startsWith("ink:")).map(i=>{const row=stock.find(s=>s.id===i.part_id);if(!row)throw new ReviewRequired("Use Liquid stock in ml for the printer's ink slots.");return {...row,slot:i.slot};}).sort((a,b)=>a.slot.localeCompare(b.slot));
  if(!page.items.length)throw new ReviewRequired("Inventory returned an incomplete ink stock list.");
 }
 throw new ReviewRequired("Narrow the ink stock list before preparing a print.");
}
