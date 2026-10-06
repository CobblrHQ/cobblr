import {isDeepStrictEqual} from "node:util";
import {createHash} from "node:crypto";
import {z} from "zod";
import {platform} from "@cobblr/platform-contract";
import {normaliseActionResult} from "@cobblr/platform-contract/action-result";
import type {Kysely} from "kysely";
import {CutterProfileSchema,validateCutterProgram,type CutterProgram,type CutterController} from "@cobblr/platform-contract/cutter-program";
import type {DigifabDB} from "./db.js";
import {parseDesign} from "./laser-design.js";
import {nestParts} from "./laser-layout.js";
import {compileCutterPlan} from "./cutter-motion-plan.js";
import {currentCutterRoll,cutterRollMismatch,type CutterRoll} from "./cutter-stock.js";
import {buildDriverById,recordJobOutcome} from "./jobs-core.js";
import {ReviewRequired} from "./drivers/job-review.js";
const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export const CutterMachine=z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200)});
export const NewCutterProfile=CutterMachine.extend({profile:CutterProfileSchema});
export const NewCutterPlan=CutterMachine.extend({library_id:z.string().uuid(),roll_id:z.string().uuid(),mapping:z.record(z.string().uuid()),quantity:z.number().int().min(1).max(1000).default(1),length_mm:z.number().finite().positive().max(100000),spacing_mm:z.number().finite().min(0).max(100).default(2),mirror:z.boolean().optional(),weed_box_mm:z.number().finite().min(0).max(100).default(0),weed_line_spacing_mm:z.number().finite().min(0).max(1000).default(0),dxf_units:z.enum(["mm","in"]).default("mm")});
export interface CutterPlan {program:CutterProgram;roll:CutterRoll;content_hash:string;source_hash:string;source_library_id:string;quantity:number;used_length_m:number}
export const CutterReportSchema=z.object({verdict:z.enum(["good","scrap"]),used_length_m:z.number().finite().nonnegative().max(1000),idle_confirmed:z.literal(true),blade_up_confirmed:z.literal(true)});
export type CutterReport=z.infer<typeof CutterReportSchema>;
export async function cutterMachine(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof CutterMachine>) {
 const driver=await buildDriverById(db,orgId,b.connection_id);
 if(!driver?.prepareJob || await driver.jobReviewKind?.()!=="cutter" || !await driver.jobReviewRequired?.())throw new ReviewRequired("Choose a connected cutter with station review.");
 const device=(await driver.listDevices()).find(d=>d.id===b.device_id);
 if(!device || device.enabled === false || device.station_kind!=="cutter" || !device.raw?.cutterController)throw new ReviewRequired("Save this cutter's bridge configuration first.");
 const controller=device.raw.cutterController as CutterController;
 if(![controller.width_mm,controller.length_mm].every(n=>Number.isFinite(n)&&n>0))throw new ReviewRequired("Save this cutter's width and feed range first.");
 return {driver,device,controller};
}
export async function createCutterProfile(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof NewCutterProfile>) {
 await cutterMachine(db,orgId,b);
 return db.insertInto("digifab_cutter_profiles").values({connection_id:b.connection_id,remote_device_id:b.device_id,profile:b.profile}).returningAll().executeTakeFirstOrThrow();
}
export async function createCutterPlan(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof NewCutterPlan>) {
 const {controller}=await cutterMachine(db,orgId,b),roll=await currentCutterRoll(orgId,b.connection_id,b.device_id,b.roll_id);
 if(roll.config.width_mm>controller.width_mm || b.length_mm>controller.length_mm)throw new ReviewRequired("The chosen roll width or feed length exceeds this cutter's saved range.");
 const source=await db.selectFrom("digifab_library").selectAll().where("id","=",b.library_id).executeTakeFirst(),file=source&&await platform().files.read(orgId,source.file_id);
 if(!file || !/\.(svg|dxf)$/i.test(file.filename))throw new ReviewRequired("Choose an SVG or DXF drawing from the Library.");
 const records=await db.selectFrom("digifab_cutter_profiles").selectAll().where("connection_id","=",b.connection_id).where("remote_device_id","=",b.device_id).execute();
 const profiles=Object.fromEntries(Object.entries(b.mapping).map(([layer,id])=>{const row=records.find(r=>r.id===id);if(!row)throw new ReviewRequired("Choose a profile tested on this cutter for every layer.");return [layer,row.profile];}));
 const materials=new Set(Object.values(profiles).map(p=>p.material.toLowerCase()));
 if(materials.size!==1)throw new ReviewRequired("Use one material throughout a cutter job.");
 const design=parseDesign(file.filename,file.bytes,b.dxf_units),margin=b.weed_box_mm+2*Math.max(...Object.values(profiles).map(p=>p.blade_offset_mm))+0.1;
 const width=roll.config.width_mm,height=b.length_mm;
 if(design.width+2*margin>width)throw new ReviewRequired("This design is wider than the loaded roll, including the blade and weed margin.");
 if(width<=2*margin || height<=2*margin)throw new ReviewRequired("The roll cannot fit the blade and weed margins.");
 const sheets=nestParts(design,b.quantity,[{id:roll.id,width,height,revision:roll.revision,free_rectangles:[{x:margin,y:margin,width:width-2*margin,height:height-2*margin}]}],b.spacing_mm,0,false);
 const program=compileCutterPlan(design,sheets[0]!,profiles,{width:controller.width_mm,height:controller.length_mm},b);
 const used_length_m=(program.bounds.y+program.bounds.height)/1000;
 const reason=cutterRollMismatch(roll,roll,used_length_m);if(reason)throw new ReviewRequired(reason);
 const bytes=Buffer.from(JSON.stringify(program));if(bytes.length>20*1024*1024)throw new ReviewRequired("Make a cutter plan smaller than 20 MB.");
 const stored=await platform().files.write(orgId,bytes,{filename:`cut-${source!.id}.cutterplan`,mimeType:"application/json"});
 if(!stored)throw new ReviewRequired("The prepared cut could not be saved.");
 const plan:CutterPlan={program,roll,quantity:b.quantity,used_length_m,content_hash:hash(bytes),source_hash:hash(file.bytes),source_library_id:source!.id};
 return db.transaction().execute(async trx=>{
  const library=await trx.insertInto("digifab_library").values({name:`${source!.name} · Cut`,file_id:stored.fileId,thumbnail_file_id:null,kind:"cutter-plan",size_bytes:bytes.length,plate_count:1,notes:"Prepared cutter plan. Review and Start at its station.",metadata:{cutter_plan:true,mirrored:program.mirrored,mirror_label:program.mirror_label}}).returning("id").executeTakeFirstOrThrow();
  const job=await trx.insertInto("digifab_jobs").values({connection_id:b.connection_id,target_device:b.device_id,file_id:stored.fileId,file_ref:`${source!.name}.cutterplan`,max_attempts:1,metadata:{cutter_plan:true}}).returning("id").executeTakeFirstOrThrow();
  return trx.insertInto("digifab_cutter_plans").values({connection_id:b.connection_id,remote_device_id:b.device_id,library_id:library.id,job_id:job.id,plan}).returningAll().executeTakeFirstOrThrow();
 });
}
export async function verifyCutterPlan(db:Kysely<DigifabDB>,orgId:string,jobId:string,connectionId:string,deviceId:string,loaded=false,allowStarted=false) {
 const saved=await db.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",jobId).where("connection_id","=",connectionId).where("remote_device_id","=",deviceId).executeTakeFirst();
 if(!saved || !allowStarted && saved.started_at || saved.consumed_at)throw new ReviewRequired("Use an unstarted cutter plan prepared for this job and machine.");
 const library=await db.selectFrom("digifab_library").selectAll().where("id","=",saved.library_id).executeTakeFirst(),job=await db.selectFrom("digifab_jobs").selectAll().where("id","=",jobId).executeTakeFirst();
 if(library?.kind!=="cutter-plan" || job?.file_id!==library.file_id)throw new ReviewRequired("The queued cutter file changed. Prepare a new plan.");
 const file=await platform().files.read(orgId,library.file_id);
 if(!file || hash(file.bytes)!==saved.plan.content_hash)throw new ReviewRequired("The queued cutter output changed. Prepare a new plan.");
 const program=validateCutterProgram(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
 if(!isDeepStrictEqual(program,saved.plan.program))throw new ReviewRequired("The reviewed cutter geometry changed.");
 const roll=await currentCutterRoll(orgId,connectionId,deviceId,saved.plan.roll.id,loaded),reason=cutterRollMismatch(saved.plan.roll,roll,saved.plan.used_length_m);
 if(reason)throw new ReviewRequired(reason);
 const {controller}=await cutterMachine(db,orgId,{connection_id:connectionId,device_id:deviceId});
 if(program.width_mm>controller.width_mm||program.length_mm>controller.length_mm)throw new ReviewRequired("The cut no longer fits this cutter's configured range.");
 return saved;
}
export async function recordCutterUse(db:Kysely<DigifabDB>,orgId:string,jobId:string,userId:string,asked:CutterReport) {
 const report=CutterReportSchema.parse(asked);
 const saved=await db.transaction().execute(async trx=>{
  const row=await trx.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",jobId).forUpdate().executeTakeFirst();
  if(!row)throw new ReviewRequired("Choose this cutter's original job for the outcome.");
  const job=await trx.selectFrom("digifab_jobs").selectAll().where("id","=",jobId).executeTakeFirstOrThrow();
  if(!["completed","failed","cancelled"].includes(job.status))throw new ReviewRequired("Confirm the cutter has stopped before recording the used roll.");
  if(job.status!=="completed" && report.verdict==="good")throw new ReviewRequired("An interrupted cut is scrap. Measure the used roll at the machine.");
  if(!row.started_at && report.used_length_m>0)throw new ReviewRequired("An unstarted cut cannot report fed roll material. Discard it with zero used metres.");
  if(row.report && !isDeepStrictEqual(row.report,report))throw new ReviewRequired("This outcome was already recorded. Retry the original used length and verdict.");
  if(job.status==="completed" && report.used_length_m<row.plan.used_length_m-0.000001)throw new ReviewRequired("A finished cut must account for its full prepared length.");
  if(!row.report)await trx.updateTable("digifab_cutter_plans").set({report}).where("id","=",row.id).execute();
  return row;
 });
 if(saved.consumed_at)return {ok:true};
 if(saved.started_at && report.used_length_m+saved.plan.roll.config.waste>0) {
  const roll=await currentCutterRoll(orgId,saved.connection_id,saved.remote_device_id,saved.plan.roll.id,false,true);
  if(roll.kind!==saved.plan.roll.kind || roll.config.width_mm!==saved.plan.roll.config.width_mm)throw new ReviewRequired("Keep the original roll stock record until its used length is saved.");
  const out=normaliseActionResult(await platform().actions.invoke("inventory:consume-stock",{orgId,userId,entity:{kind:roll.kind,id:roll.id},args:{fields:{revision:roll.revision,source:`cutter:${jobId}`,verdict:report.verdict,amount:report.used_length_m+saved.plan.roll.config.waste,unit:"m",waste:0}},event:{name:"digifab.job.outcome",payload:{jobId},actor:{user_id:userId,display_name:null,auth_method:"session"},timestamp:new Date().toISOString(),trigger_type:"user-invoked"}}),"inventory:consume-stock");
  if(!out.ok)throw new ReviewRequired("The roll use could not be recorded. Keep this roll reserved and retry the same outcome.");
 }
 await recordJobOutcome(db,orgId,jobId,report.verdict,"bed-clear",{good:report.verdict==="good"?saved.plan.quantity:0,scrap:report.verdict==="scrap"?saved.plan.quantity:0});
 await db.transaction().execute(async trx=>{
  await trx.updateTable("digifab_cutter_plans").set({consumed_at:new Date()}).where("id","=",saved.id).execute();
  await trx.deleteFrom("digifab_cutter_roll_claims").where("job_id","=",jobId).execute();

  await trx.deleteFrom("digifab_device_attention").where("connection_id","=",saved.connection_id).where("remote_device_id","=",saved.remote_device_id).where("job_id","=",jobId).execute();
 });
 return {ok:true};
}
