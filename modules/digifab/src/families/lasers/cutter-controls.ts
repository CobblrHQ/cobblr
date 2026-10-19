import {requireLaserBedReady} from "../../laser-station.js";
import {z} from "zod";
import {platform} from "@cobblr/platform-contract";
import type {Kysely} from "kysely";
import type {DigifabDB} from "../../db.js";
import {buildDriverById,pollJob} from "../../jobs-core.js";
import {requireCutterStation} from "../../cutter-station.js";
import {verifyCutterPlan} from "../../cutter-plans.js";
import {ReviewRequired} from "../../drivers/job-review.js";
export const CutterControlSchema=z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200),operation:z.enum(["stop","pause","resume","frame","confirm-idle"]),job_id:z.string().uuid().optional(),file_id:z.string().max(1000).optional(),project_hash:z.string().max(128).optional(),station_token:z.string().min(32).max(128).optional(),idle_confirmed:z.boolean().optional(),blade_up_confirmed:z.boolean().optional()});
export async function cutterControl(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof CutterControlSchema>) {
 const driver=await buildDriverById(db,orgId,b.connection_id);
 if(!driver?.runControl || await driver.jobReviewKind?.()!=="cutter")throw new ReviewRequired("Choose a connected cutter control.");
 const stopping=b.operation==="stop"?await db.updateTable("digifab_jobs").set({cancel_requested_at:new Date(),updated_at:new Date()}).where("connection_id","=",b.connection_id).where("target_device","=",b.device_id).where(eb=>eb.or([eb("status","in",["queued","sent","printing","paused"]),eb("send_token","is not",null)])).returning(["id","remote_job_id"]).execute():[];
 const checkMotionAllowed=async()=>{
  await requireCutterStation(db,b.connection_id,b.device_id,b.station_token);
  if(b.operation==="frame") {
   if(!b.job_id||!b.file_id||!b.project_hash)throw new ReviewRequired("Review the queued cutter job before Frame.");
   const saved=await verifyCutterPlan(db,orgId,b.job_id,b.connection_id,b.device_id,true);
   const job=await db.selectFrom("digifab_jobs").select(["cancel_requested_at","status"]).where("id","=",b.job_id).executeTakeFirst();
   if(job?.status!=="queued"||job.cancel_requested_at)throw new ReviewRequired("Stop was requested. Review this cutter plan again.");
   await requireLaserBedReady(db,{id:b.job_id,connection_id:b.connection_id,target_device:b.device_id});
   const review=await driver.getJobReview?.(b.file_id);
   if(!review || review.projectHash!==b.project_hash || review.contentHash!==saved.plan.content_hash)throw new ReviewRequired("The cutter file changed. Prepare a fresh review.");
  }else if(b.operation==="confirm-idle" && (b.idle_confirmed!==true||b.blade_up_confirmed!==true))throw new ReviewRequired("Confirm idle and blade up at this cutter before continuing.");
 };
 let result:{ok:boolean;detail?:string}={ok:false};
 const work=async()=>{if(["frame","confirm-idle"].includes(b.operation))await checkMotionAllowed();result=await driver.runControl!(b.device_id,b.operation,{fileId:b.file_id,projectHash:b.project_hash,idle_confirmed:b.idle_confirmed,blade_up_confirmed:b.blade_up_confirmed,checkMotionAllowed});};
 if(b.operation==="frame") {const lock=await platform().exclusive.run(`laser-start:${orgId}:${b.connection_id}:${b.device_id}`,work);if(!lock.ran)throw new ReviewRequired("The cutter is preparing another operation. Wait before Frame.");}else await work();
 for(const job of stopping)if(job.remote_job_id)await pollJob(db,orgId,job.id);
 if(b.operation==="confirm-idle"&&b.job_id)await pollJob(db,orgId,b.job_id);
 if(!result.ok)throw new ReviewRequired(result.detail||"The cutter did not confirm its control. Use the physical Stop if it is moving.");
 return {ok:true,detail:result.detail};
}
