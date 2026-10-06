import {CutterChecksSchema} from "./cutter-checks.js";
import type {Kysely,Selectable} from "kysely";
import type {DigifabDB} from "./db.js";
import type {JobApproval} from "./drivers/types.js";
import {ReviewRequired} from "./drivers/job-review.js";
import {stationTokenHash,requireLaserBedReady,type StationPermit} from "./laser-station.js";
import {verifyCutterPlan} from "./cutter-plans.js";

const permits=new WeakSet<object>();
export function hasCutterPermit(permit:StationPermit|undefined,approval:JobApproval):boolean {return !!permit && permits.has(permit)&&permit.fileId===approval.fileId&&permit.projectHash===approval.projectHash;}
export async function requireCutterStation(db:Kysely<DigifabDB>,connectionId:string,deviceId:string,token:unknown):Promise<void> {
 if(typeof token!=="string" || token.length<32)throw new ReviewRequired("Authorize this screen at the cutter's station first.");
 const station=await db.selectFrom("digifab_stations").select("id").where("connection_id","=",connectionId).where("remote_device_id","=",deviceId).where("token_hash","=",stationTokenHash(token)).where("revoked_at","is",null).executeTakeFirst();
 if(!station)throw new ReviewRequired("This screen is not authorized for this cutter.");
}
export async function authorizeCutterStart(db:Kysely<DigifabDB>,orgId:string,job:Selectable<DigifabDB["digifab_jobs"]>,approval?:JobApproval):Promise<StationPermit> {
 if(!approval || !job.connection_id || !job.target_device)throw new ReviewRequired("Approve at the cutter's station.");
 await requireCutterStation(db,job.connection_id,job.target_device,approval.stationToken);
 if(!CutterChecksSchema.safeParse(approval.cutterChecks).success)throw new ReviewRequired("Check the loaded roll, blade depth, zero native offset, test cut and origin at this cutter before Start.");
 await requireLaserBedReady(db,job);
 const saved=await verifyCutterPlan(db,orgId,job.id,job.connection_id,job.target_device,true);
 await db.transaction().execute(async trx=>{
  await trx.insertInto("digifab_cutter_roll_claims").values({part_id:saved.plan.roll.id,job_id:job.id}).onConflict(c=>c.column("part_id").doNothing()).execute();
  const winner=await trx.selectFrom("digifab_cutter_roll_claims").select("job_id").where("part_id","=",saved.plan.roll.id).executeTakeFirstOrThrow();
  if(winner.job_id!==job.id)throw new ReviewRequired("This roll is reserved by another cutter job. Record its outcome first.");
 });
 const permit=Object.freeze({fileId:approval.fileId,projectHash:approval.projectHash});permits.add(permit);return permit;
}
