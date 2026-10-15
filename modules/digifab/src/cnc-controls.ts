import { createHash } from "node:crypto";
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { CncMachineSchema } from "@cobblr/platform-contract/cnc";
import type { DigifabDB } from "./db.js";
import type { MachineDriver, CommandResult } from "./drivers/types.js";
import { controlDirectLaser } from "./laser-controls.js";
import { buildDriverById, pollJob } from "./jobs-core.js";
import { parseCncProgram, validateCncMachineBounds } from "./cnc-program.js";
import { mayControl, RUN_MACHINES_REFUSAL } from "./motion-gate.js";

const CncControl=z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200),operation:z.enum(["stop","pause","resume","frame"]),file_id:z.string().max(1000).optional(),job_id:z.string().uuid().optional()});
export async function controlCnc(db:Kysely<DigifabDB>,orgId:string,driver:MachineDriver,deviceId:string,operation:string,params:Record<string,unknown>,connectionId:string):Promise<CommandResult> {
 if(!driver.runControl || await driver.jobReviewKind?.()!=="cnc" || !["stop","pause","resume","frame"].includes(operation)) return {ok:false,detail:"Choose a CNC machine control."};
 if(operation==="frame") {
  let result:CommandResult={ok:false};
  const locked=await platform().exclusive.run(`laser-start:${orgId}:${connectionId}:${deviceId}`,async()=>{result=await frameCnc(db,orgId,driver,deviceId,params,connectionId);});
  return locked.ran?result:{ok:false,detail:"This CNC machine is preparing or starting a job. Wait before Frame."};
 }
 const stopping=operation==="stop"?await db.updateTable("digifab_jobs").set({cancel_requested_at:new Date(),updated_at:new Date()}).where("connection_id","=",connectionId).where("target_device","=",deviceId).where(eb=>eb.or([eb("status","in",["queued","sent","printing","paused","assigning"]),eb("send_token","is not",null)])).returning(["id","remote_job_id"]).execute():[];
 const result=await driver.runControl(deviceId,operation,params);
 if(result.ok) for(const job of stopping) if(job.remote_job_id) await pollJob(db,orgId,job.id);
 return result;
}
async function frameCnc(db:Kysely<DigifabDB>,orgId:string,driver:MachineDriver,deviceId:string,params:Record<string,unknown>,connectionId:string):Promise<CommandResult> {
 if(typeof params.jobId!=="string") return {ok:false,detail:"Choose the queued CNC program before Frame."};
 const job=await db.selectFrom("digifab_jobs").select(["file_id","status"]).where("id","=",params.jobId).where("connection_id","=",connectionId).where("target_device","=",deviceId).executeTakeFirst();
 if(job?.status!=="queued"||!job.file_id) return {ok:false,detail:"Frame a queued program at this CNC machine."};
 const source=await platform().files.read(orgId,job.file_id),review=await driver.getJobReview?.(String(params.fileId??""));
 if(!source||!review||review.contentHash!==createHash("sha256").update(source.bytes).digest("hex")) return {ok:false,detail:"Review this queued CNC program before Frame."};
 const machine=CncMachineSchema.parse(review.project.machine);
 validateCncMachineBounds(parseCncProgram(Buffer.from(source.bytes).toString("utf8"),machine.rapidFeed),machine);
 const checkMotionAllowed=async()=>{
  const current=await db.selectFrom("digifab_jobs").select(["status","cancel_requested_at"]).where("id","=",params.jobId as string).executeTakeFirst();
  if(!current||current.status!=="queued"||current.cancel_requested_at) throw new Error("Stop was requested. Review this CNC program again before Frame.");
 };
 await checkMotionAllowed();
 return driver.runControl!(deviceId,"frame",{...params,checkMotionAllowed});
}
export function registerMachineControlAction():void {
 platform().actions.registerHandler("digifab.machine-control",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"})) return {ok:false,error:"Sign in to this workspace to use its CNC controls."};
  const parsed=CncControl.safeParse(ctx.args);if(!parsed.success)return {ok:false,error:parsed.error.message};
  if(!await mayControl({orgId:ctx.orgId,userId:ctx.userId,operation:parsed.data.operation}))return {ok:false,error:RUN_MACHINES_REFUSAL};
  const b=parsed.data,db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,driver=await buildDriverById(db,ctx.orgId,b.connection_id);
  if(!driver)return {ok:false,error:"The CNC machine is not connected."};
  const control=driver.laserBackend?controlDirectLaser:controlCnc;
  const result=await control(db,ctx.orgId,driver,b.device_id,b.operation,{fileId:b.file_id,jobId:b.job_id},b.connection_id);
  return result.ok?{ok:true}:{ok:false,error:result.detail??"The CNC controller did not accept the control."};
 });
}
