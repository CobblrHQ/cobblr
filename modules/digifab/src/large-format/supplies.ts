import {z} from "zod";
import type {Kysely} from "kysely";
import {platform} from "@cobblr/platform-contract";
import type {DigifabDB} from "../db.js";
import {largePrinter,type Printer} from "./service.js";
import {inkTransition} from "./plan.js";
export const SupplySchema=z.object({id:z.string().min(1).max(100),name:z.string().max(300),percent:z.number().finite().min(0).max(100).nullable(),remaining_ml:z.number().finite().nonnegative().nullable(),type:z.number().int().nullable()});
export type SupplyReading=z.infer<typeof SupplySchema>;
export async function refreshSupplies(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof Printer>) {
 const {device}=await largePrinter(db,orgId,b),supplies=z.array(SupplySchema).max(32).parse(device.raw?.supplies??[]),low:SupplyReading[]=[];
 for(const reading of supplies) {
  const notify=await db.transaction().execute(async trx=>{
   await trx.insertInto("digifab_printer_supplies").values({connection_id:b.connection_id,device_id:b.device_id,supply_id:reading.id,reading,low:false}).onConflict(c=>c.columns(["connection_id","device_id","supply_id"]).doNothing()).execute();
   const old=await trx.selectFrom("digifab_printer_supplies").select("low").where("connection_id","=",b.connection_id).where("device_id","=",b.device_id).where("supply_id","=",reading.id).forUpdate().executeTakeFirstOrThrow();
   const next=inkTransition(old.low,[3,5,6,7,21].includes(reading.type??2)?reading.percent:null,10);
   await trx.updateTable("digifab_printer_supplies").set({reading,low:next.low,updated_at:new Date()}).where("connection_id","=",b.connection_id).where("device_id","=",b.device_id).where("supply_id","=",reading.id).execute();
   return next.notify;
  });
  if(notify)low.push(reading);
 }
 if(low.length) {
  const message=`${device.name}: low ink or toner. ${low.map(i=>`${i.name}: ${i.percent}%`).join(", ")}`;
  for(const userId of await platform().notifications.audienceFor(orgId,"digifab.ink.low")) {
   // dispatch-per-row-ok: one combined supply alert for each configured recipient.
   await platform().notifications.dispatch({orgId,userId,eventType:"digifab.ink.low",module:"digifab",triggeredBy:"schedule",priority:"normal",message,link_url:`/station/machine/${b.connection_id}/${encodeURIComponent(b.device_id)}`,payload:{connectionId:b.connection_id,deviceId:b.device_id,supplies:low}});
  }
 }
 return {ok:true,device};
}
let registered=false;
export function registerSupplyPolling():void {
 if(registered)return;registered=true;
 platform().sweeps.register({name:"digifab.printer-supplies",module:"digifab",everyMs:60000,candidates:async ids=>ids,visit:async({orgId,db:raw})=>{
  const db=raw as Kysely<DigifabDB>,printers=await db.selectFrom("digifab_printer_supplies").select(["connection_id","device_id"]).distinct().execute();
  for(const printer of printers)try{await refreshSupplies(db,orgId,printer);}catch(error){platform().health.notePassFailure("digifab.printer-supplies",orgId,error);}
 }});
}
