import { z } from "zod";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import type { MachineDriver, CommandResult } from "../../drivers/types.js";
import { laserBed } from "../../sheet-layout.js";
import { validateLaserPlan } from "./laser-motion-plan.js";
import { pollJob, buildDriverById } from "../../jobs-core.js";
import { platform } from "@cobblr/platform-contract";
import { mayControl, RUN_MACHINES_REFUSAL } from "../../motion-gate.js";
export const LaserControl = z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200),operation:z.enum(["stop","pause","resume","frame"]),file_id:z.string().max(1000).optional(),job_id:z.string().uuid().optional()});
export async function controlDirectLaser(db:Kysely<DigifabDB>,orgId:string,driver:MachineDriver,deviceId:string,operation:string,params:Record<string,unknown>,connectionId:string):Promise<CommandResult>{
 if(!driver.laserBackend||!driver.runControl||!["stop","pause","resume","frame"].includes(operation))return {ok:false,detail:"Choose a direct laser control."};
 if(operation === "frame") {
  let result:CommandResult={ok:false};
  const locked=await platform().exclusive.run(`laser-start:${orgId}:${connectionId}:${deviceId}`,async()=>{result=await frameDirectLaser(db,orgId,driver,deviceId,params,connectionId);});
  if(!locked.ran)return {ok:false,detail:"The laser is preparing or starting another operation. Wait before Frame."};
  return result;
 }
 const stopping = operation === "stop" ? await db.updateTable("digifab_jobs").set({cancel_requested_at:new Date(),updated_at:new Date()}).where("connection_id","=",connectionId).where("target_device","=",deviceId).where(eb => eb.or([eb("status", "in", ["queued", "sent", "printing", "paused", "assigning"]), eb("send_token", "is not", null)])).returning(["id", "remote_job_id"]).execute() : [];
 const result=await driver.runControl(deviceId,operation,params);
 if(result.ok)for(const job of stopping)if(job.remote_job_id)await pollJob(db,orgId,job.id);
 return result;
}

async function frameDirectLaser(db:Kysely<DigifabDB>,orgId:string,driver:MachineDriver,deviceId:string,params:Record<string,unknown>,connectionId:string):Promise<CommandResult>{
  if(typeof params.jobId !== "string")return {ok:false,detail:"Choose the queued sheet job before Frame."};
  const job=await db.selectFrom("digifab_jobs").select(["file_id", "status"]).where("id","=",params.jobId).where("connection_id","=",connectionId).where("target_device","=",deviceId).executeTakeFirst();
  if(job?.status!=="queued"||!job.file_id)return {ok:false,detail:"Frame a queued job at this laser."};
  const source=await platform().files.read(orgId,job.file_id);
  if(!source)return {ok:false,detail:"The queued laser file is missing."};
  const plan=validateLaserPlan(JSON.parse(Buffer.from(source.bytes).toString("utf8"))),bed=await laserBed(db,orgId,connectionId,deviceId);
  if(plan.bounds.x+plan.bounds.width>bed.width||plan.bounds.y+plan.bounds.height>bed.height)return {ok:false,detail:"This job no longer fits the saved bed. Make a new plan before Frame."};
  const review=await driver.getJobReview?.(String(params.fileId??""));
  const {createHash}=await import("node:crypto");
  if(!review||review.contentHash!==createHash("sha256").update(source.bytes).digest("hex"))return {ok:false,detail:"Review this queued job before Frame."};
 const checkMotionAllowed=async()=>{
  const current=await db.selectFrom("digifab_jobs").select(["status","cancel_requested_at"]).where("id","=",params.jobId as string).executeTakeFirst();
  if(!current||current.status!=="queued"||current.cancel_requested_at)throw new Error("Stop was requested. Review this job again before Frame.");
 };
 await checkMotionAllowed();
 return driver.runControl!(deviceId,"frame",{...params,checkMotionAllowed});
}
export function registerLaserControlAction():void {
 platform().actions.registerHandler("digifab.laser-control",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"Sign in to this workspace to use its laser controls."};
  const parsed=LaserControl.safeParse(ctx.args);if(!parsed.success)return {ok:false,error:parsed.error.message};
  if(!await mayControl({orgId:ctx.orgId,userId:ctx.userId,operation:parsed.data.operation}))return {ok:false,error:RUN_MACHINES_REFUSAL};
  const b=parsed.data,db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,driver=await buildDriverById(db,ctx.orgId,b.connection_id);
  if(!driver)return {ok:false,error:"The laser is not connected."};
  const result=await controlDirectLaser(db,ctx.orgId,driver,b.device_id,b.operation,{fileId:b.file_id,jobId:b.job_id},b.connection_id);
  return result.ok?{ok:true}:{ok:false,error:result.detail??"The laser did not accept the control."};
 });
}
