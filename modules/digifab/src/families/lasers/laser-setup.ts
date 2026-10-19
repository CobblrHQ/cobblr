import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { LaserSetupRequestSchema, type LaserSetup } from "@cobblr/platform-contract/laser-setup";
import type { DigifabDB } from "../../db.js";
import { stationTokenHash } from "../../laser-station.js";
import { buildDriverById } from "../../jobs-core.js";
import { ReviewRequired } from "../../drivers/job-review.js";

export async function checkLaserSetupStation(db:Kysely<DigifabDB>,connectionId:string,deviceId:string,stationToken?:string):Promise<void>{
 if(!stationToken)throw new ReviewRequired("Use this laser's authorized station for setup.");
 const station=await db.selectFrom("digifab_stations").select("id").where("token_hash","=",stationTokenHash(stationToken)).where("connection_id","=",connectionId).where("remote_device_id","=",deviceId).where("revoked_at","is",null).executeTakeFirst();
 if(!station)throw new ReviewRequired("This screen is not approved for this laser.");
 const attention=await db.selectFrom("digifab_device_attention").select("job_id").where("connection_id","=",connectionId).where("remote_device_id","=",deviceId).executeTakeFirst();
 if(attention)throw new ReviewRequired("Remove the pieces and record their outcome before Home or setup.");
 const active=await db.selectFrom("digifab_jobs").select("id").where("connection_id","=",connectionId).where("target_device","=",deviceId).where(eb=>eb.or([eb("status","in",["sent","printing","paused","assigning"]),eb("send_token","is not",null)])).executeTakeFirst();
 if(active)throw new ReviewRequired("Finish the current job before Home or setup.");
}
export async function runLaserSetup(db:Kysely<DigifabDB>,orgId:string,input:unknown):Promise<LaserSetup>{
 const b=LaserSetupRequestSchema.parse(input),driver=await buildDriverById(db,orgId,b.connection_id);
 if(!driver?.laserBackend||!driver.getLaserSetup)throw new ReviewRequired("Choose a connected direct bridge laser for setup.");
 const devices=await driver.listDevices();if(!devices.some(d=>d.id===b.device_id))throw new ReviewRequired("This connection fronts a different laser.");
 if(b.operation==="read")return driver.getLaserSetup();
 const check=()=>checkLaserSetupStation(db,b.connection_id,b.device_id,b.station_token);
 await check();let report:LaserSetup|undefined;
 const locked=await platform().exclusive.run(`laser-start:${orgId}:${b.connection_id}:${b.device_id}`,async()=>{
  if(b.operation==="home"){
   if(!driver.homeLaser)throw new ReviewRequired("This laser does not support Home from its station.");
   report=await driver.homeLaser(check);
  }else{
   if(!b.configuration||!driver.commissionLaser)throw new ReviewRequired("Confirm this firmware's reported configuration at its station.");
   report=await driver.commissionLaser(b.configuration,check);
  }
 });
 if(!locked.ran||!report)throw new ReviewRequired("The laser is preparing another operation. Wait before setup.");
 return report;
}
export function registerLaserSetupAction():void{
 platform().actions.registerHandler("digifab.laser-setup",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"admin"}))return {ok:false,error:"An admin must set up this laser at its station."};
  const db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
  try{return {ok:true,data:await runLaserSetup(db,ctx.orgId,ctx.args)};}catch(error){return {ok:false,error:error instanceof Error?error.message:"The laser setup could not be confirmed."};}
 });
}
