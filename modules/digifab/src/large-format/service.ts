import {loadedInk,type LoadedInk} from "./stock.js";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import type {Kysely} from "kysely";
import {platform} from "@cobblr/platform-contract";
import {normaliseActionResult} from "@cobblr/platform-contract/action-result";
import type {DigifabDB} from "../db.js";
import {currentCutterRoll,cutterStationKey,type CutterRoll} from "../cutter-stock.js";
import {buildDriverById,recordJobOutcome} from "../jobs-core.js";
import {ReviewRequired} from "../drivers/job-review.js";
import {printDocument} from "./document.js";
import {planRollPrint} from "./plan.js";
export const Printer=z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200)});
export const PrintRequest=Printer.extend({library_id:z.string().uuid(),roll_id:z.string().uuid(),copies:z.number().int().min(1).max(1000).default(1),margin_mm:z.number().finite().min(0).max(500).default(0),media_type:z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).default("stationery"),width_mm:z.number().finite().positive().max(10000).optional(),height_mm:z.number().finite().positive().max(10000).optional()});
export const PrintReport=z.object({verdict:z.enum(["good","scrap"]),used_length_m:z.number().finite().nonnegative().max(100000),idle_confirmed:z.literal(true),ink:z.array(z.object({stock_id:z.string().uuid(),kind:z.string().min(1),amount_ml:z.number().finite().nonnegative().max(100000),estimated:z.literal(true)})).max(32).default([])});
export type PrintOutcome=z.infer<typeof PrintReport>;
export interface LargePrintPlan {ink_stock:LoadedInk[];roll:CutterRoll;width_mm:number;height_mm:number;pages:number;copies:number;margin_mm:number;media_type:string;format:string;filename:string;used_length_m:number;content_hash:string}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export async function largePrinter(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof Printer>) {
 const driver=await buildDriverById(db,orgId,b.connection_id);
 if(driver?.printProcess!=="large-format"||!await driver.jobReviewRequired?.())throw new ReviewRequired("Choose an IPP printer with station review.");
 const device=(await driver.listDevices()).find(d=>d.id===b.device_id);
 if(!device?.enabled||!device.raw?.large_format)throw new ReviewRequired("Connect this large-format printer first.");
 return {driver,device};
}
export async function createLargePrint(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof PrintRequest>) {
 await largePrinter(db,orgId,b);
 const roll=await currentCutterRoll(orgId,b.connection_id,b.device_id,b.roll_id,true);
 const source=await db.selectFrom("digifab_library").selectAll().where("id","=",b.library_id).executeTakeFirst();
 if(!source||source.size_bytes>20*1024*1024)throw new ReviewRequired("Choose a PDF or image smaller than 20 MB from the Library.");
 const file=await platform().files.read(orgId,source.file_id);
 if(!file)throw new ReviewRequired("Choose a stored PDF or image from the Library.");
 const {bytes:document,...geometry}=await printDocument(file.bytes,file.filename,b),used_length_m=planRollPrint({...b,...geometry}, {width_mm:roll.config.width_mm,remaining:roll.remaining,waste:roll.config.waste});
 const filename=file.filename.replace(/[\x00-\x1f\x7f]/g,"").slice(0,200);
 const prepared={kind:"ipp-print",document:Buffer.from(document).toString("base64"),...geometry,filename,copies:b.copies,margin_mm:b.margin_mm,media_type:b.media_type,roll_width_mm:roll.config.width_mm};
 const bytes=Buffer.from(JSON.stringify(prepared)),stored=await platform().files.write(orgId,bytes,{filename:`print-${source!.id}.ippplan`,mimeType:"application/json"});
 if(!stored)throw new ReviewRequired("The prepared document could not be saved.");
 const plan:LargePrintPlan={ink_stock:await loadedInk(orgId,b.connection_id,b.device_id),roll,...geometry,filename,copies:b.copies,margin_mm:b.margin_mm,media_type:b.media_type,used_length_m,content_hash:hash(bytes)};
 return db.transaction().execute(async trx=>{
  const job=await trx.insertInto("digifab_jobs").values({connection_id:b.connection_id,target_device:b.device_id,file_id:stored.fileId,file_ref:`${filename}.ippplan`,max_attempts:1,metadata:{large_format:true}}).returning("id").executeTakeFirstOrThrow();
  return trx.insertInto("digifab_large_prints").values({job_id:job.id,connection_id:b.connection_id,device_id:b.device_id,plan}).returningAll().executeTakeFirstOrThrow();
 });
}
export async function verifyLargePrint(db:Kysely<DigifabDB>,orgId:string,jobId:string,connection:string,device:string,allowStarted=false) {
 const row=await db.selectFrom("digifab_large_prints").selectAll().where("job_id","=",jobId).where("connection_id","=",connection).where("device_id","=",device).executeTakeFirst();
 if(!row||row.consumed_at||row.started_at&&!allowStarted)throw new ReviewRequired("Prepare a new document for this printer before Start.");
 const job=await db.selectFrom("digifab_jobs").select("file_id").where("id","=",jobId).executeTakeFirst(),file=job?.file_id&&await platform().files.read(orgId,job.file_id);
 if(!file||hash(file.bytes)!==row.plan.content_hash)throw new ReviewRequired("The reviewed document changed. Prepare a new print.");
 const roll=await currentCutterRoll(orgId,connection,device,row.plan.roll.id,true);
 if(roll.kind!==row.plan.roll.kind||roll.revision!==row.plan.roll.revision||roll.config.width_mm!==row.plan.roll.config.width_mm||roll.config.waste!==row.plan.roll.config.waste)throw new ReviewRequired("The loaded roll changed. Prepare a new print.");
 const ink=await loadedInk(orgId,connection,device);
 if(!isDeepStrictEqual(ink,row.plan.ink_stock))throw new ReviewRequired("The loaded ink changed. Prepare a new print.");
 planRollPrint(row.plan,{width_mm:roll.config.width_mm,remaining:roll.remaining,waste:roll.config.waste});
 await db.transaction().execute(async trx=>{
  await trx.insertInto("digifab_cutter_roll_claims").values({part_id:roll.id,job_id:jobId}).onConflict(c=>c.column("part_id").doNothing()).execute();
  const claim=await trx.selectFrom("digifab_cutter_roll_claims").select("job_id").where("part_id","=",roll.id).executeTakeFirstOrThrow();
  if(claim.job_id!==jobId)throw new ReviewRequired("This roll is reserved by another job. Record its outcome first.");
 });
 return row;
}
export async function recordLargePrint(db:Kysely<DigifabDB>,orgId:string,jobId:string,userId:string,asked:PrintOutcome) {
 const report=PrintReport.parse(asked);
 const saved=await db.transaction().execute(async trx=>{
  const row=await trx.selectFrom("digifab_large_prints").selectAll().where("job_id","=",jobId).forUpdate().executeTakeFirst();
  if(!row)throw new ReviewRequired("Choose this printer's prepared job.");
  const job=await trx.selectFrom("digifab_jobs").select("status").where("id","=",jobId).executeTakeFirstOrThrow();
  if(!["completed","failed","cancelled"].includes(job.status))throw new ReviewRequired("Wait for the printer to confirm it stopped before recording use.");
  if(job.status!=="completed"&&report.verdict==="good")throw new ReviewRequired("An interrupted print is scrap. Measure the used roll.");
  if(!row.started_at&&(report.used_length_m>0||report.ink.some(i=>i.amount_ml>0)))throw new ReviewRequired("An unstarted print cannot consume media or ink.");
  if(job.status==="completed"&&report.used_length_m+0.000001<row.plan.used_length_m)throw new ReviewRequired("Account for the full printed length and margins.");
  if(row.report&&!isDeepStrictEqual(row.report,report))throw new ReviewRequired("Retry the original report. This job already has an outcome.");
  if(!row.report)await trx.updateTable("digifab_large_prints").set({report}).where("job_id","=",jobId).execute();
  return row;
 });
 if(!saved.consumed_at) {
  const roll=await currentCutterRoll(orgId,saved.connection_id,saved.device_id,saved.plan.roll.id,false,true);
  if(roll.kind!==saved.plan.roll.kind||roll.config.width_mm!==saved.plan.roll.config.width_mm)throw new ReviewRequired("Keep the original roll record until its outcome is saved.");
  const draws=[{id:roll.id,kind:roll.kind,revision:roll.revision,amount:report.used_length_m,unit:"m"},...await Promise.all(report.ink.filter(i=>i.amount_ml>0).map(async i=>{
   if(!saved.plan.ink_stock.some(s=>s.id===i.stock_id&&s.kind===i.kind))throw new ReviewRequired("Account for ink from this print’s original loaded cartridges.");
   const entity=await platform().entities.lookup(orgId,i.kind,i.stock_id),stock=entity?.fields.stock as {shape?:string;revision?:number}|undefined;
   if(stock?.shape!=="liquid"||!Number.isInteger(stock.revision))throw new ReviewRequired("Record ink use against Liquid stock in Inventory.");
   return {id:i.stock_id,kind:i.kind,revision:stock.revision!,amount:i.amount_ml,unit:"ml"};
  }))];
  if(new Set(draws.map(i=>i.id)).size!==draws.length)throw new ReviewRequired("Report each ink cartridge once.");
  for(const draw of draws)if(draw.amount>0){
   const out=normaliseActionResult(await platform().actions.invoke("inventory:consume-stock",{orgId,userId,entity:{kind:draw.kind,id:draw.id},args:{fields:{revision:draw.revision,source:`large-print:${jobId}:${draw.id}`,verdict:report.verdict,amount:draw.amount,unit:draw.unit,waste:0}},event:{name:"digifab.job.outcome",payload:{jobId},actor:{user_id:userId,display_name:null,auth_method:"session"},timestamp:new Date().toISOString(),trigger_type:"user-invoked"}}),"inventory:consume-stock");
   if(!out.ok)throw new ReviewRequired("Stock use could not be saved. Keep the original stock and retry this report.");
  }
  await db.updateTable("digifab_large_prints").set({consumed_at:new Date()}).where("job_id","=",jobId).execute();
 }
 await recordJobOutcome(db,orgId,jobId,report.verdict,"bed-clear",{good:report.verdict==="good"?saved.plan.pages*saved.plan.copies:0,scrap:report.verdict==="scrap"?saved.plan.pages*saved.plan.copies:0});
 await db.transaction().execute(async trx=>{
  await trx.deleteFrom("digifab_cutter_roll_claims").where("job_id","=",jobId).execute();
  await trx.deleteFrom("digifab_device_attention").where("job_id","=",jobId).execute();
 });
 return {ok:true};
}
export const printStationKey=cutterStationKey;
export async function stopLargePrint(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof Printer>) {
 const jobs=await db.updateTable("digifab_jobs").set({cancel_requested_at:new Date(),updated_at:new Date()}).where("connection_id","=",b.connection_id).where("target_device","=",b.device_id).where(eb=>eb.or([eb("status","in",["queued","sent","printing","paused"]),eb("send_token","is not",null)])).returning(["id","remote_job_id"]).execute();
 const driver=await buildDriverById(db,orgId,b.connection_id);
 if(driver?.printProcess!=="large-format"||!driver.runControl)throw new ReviewRequired("Use Stop on the printer. Its bridge is unavailable.");
 const active=jobs.find(j=>j.remote_job_id),result=await driver.runControl(b.device_id,"stop",active?.remote_job_id?{jobId:active.remote_job_id}:{});
 if(!result.ok)throw new ReviewRequired(result.detail||"Stop was not confirmed. Use the printer's Stop.");
 return {ok:true,detail:result.detail};
}
