import {z} from "zod";
import type {Kysely} from "kysely";
import {platform,readJsonArg} from "@cobblr/platform-contract";
import type {DigifabDB} from "../db.js";
import {Printer,PrintRequest,PrintReport,createLargePrint,recordLargePrint} from "./service.js";
import {refreshSupplies} from "./supplies.js";
import {requireCutterStation} from "../cutter-station.js";
/** A prepared large-format print's outcome, at its authorized station: digifab:large-format and digifab:station-run. */
export async function recordLargePrintOutcome(db:Kysely<DigifabDB>,orgId:string,jobId:string,userId:string,fields:unknown) {
 const saved=await db.selectFrom("digifab_large_prints").selectAll().where("job_id","=",jobId).executeTakeFirst();
 if(!saved)return {ok:false,error:"Choose a prepared print."};
 await requireCutterStation(db,saved.connection_id,saved.device_id,(fields as Record<string,unknown>).station_token);
 return await recordLargePrint(db,orgId,jobId,userId,PrintReport.parse(fields));
}
let registered=false;
export function registerLargeFormatActions():void {
 if(registered)return;registered=true;
 platform().actions.registerHandler("digifab.large-format",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"admin"}))return {ok:false,error:"Preparing prints requires an admin."};
  const args=ctx.args??{},fields=readJsonArg(args,"fields")??{},db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
  if(args.operation==="plan")return {ok:true,...await createLargePrint(db,ctx.orgId,PrintRequest.parse(fields))};
  if(args.operation==="refresh")return await refreshSupplies(db,ctx.orgId,Printer.parse(fields));
  if(args.operation==="outcome")return await recordLargePrintOutcome(db,ctx.orgId,z.string().uuid().parse(args.id),ctx.userId,fields);
  return {ok:false,error:"Choose plan, refresh or outcome."};
 });
}
