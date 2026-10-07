import { type Kysely } from "kysely";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { instrumentReadingText } from "@cobblr/platform-contract/instrument-reading";
import { platform, textSearchWhere } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { buildDriverById } from "./jobs-core.js";
import { BenchRequest, type BenchRequestInput } from "./bench-model.js";
import { scopeScreenshotPng } from "./bench-screenshot.js";
import { logBenchReading } from "./bench-log.js";
export async function benchMachine(db:Kysely<DigifabDB>,orgId:string,machineId:string){
 const links=await db.selectFrom("digifab_device_links").selectAll().where("machine_id","=",machineId).execute();
 const instruments=[];
 for(const link of links){
  const driver=await buildDriverById(db,orgId,link.connection_id);if(!driver?.readBench||driver.benchInstrument===false)continue;
  const device=(await driver.listDevices()).find(d=>d.id===link.remote_device_id);
  if(device?.raw?.bench)instruments.push({link,driver,device});
 }
 if(instruments.length>1)throw new Error("Link this machine to one bench instrument before reading it.");
 return instruments[0] || null;
}
export async function runBench(db:Kysely<DigifabDB>,orgId:string,raw:unknown,userId:string|null=null){
 const input:BenchRequestInput=BenchRequest.parse(raw);
 const machine=await benchMachine(db,orgId,input.machine_id);if(!machine)throw new Error("Link this machine to a SCPI bridge instrument first.");
 const {driver,link}=machine;
 if(input.operation==="identify"){
  if(!driver.identifyBench)throw new Error("Update the bridge to identify this instrument.");
  return driver.identifyBench();
 }
 if(input.operation==="read")return driver.readBench!();
 if(input.operation==="output_off"){
  const result=await driver.runControl?.(link.remote_device_id,"output-off",{});if(!result?.ok)throw new Error(result?.detail || "The instrument did not confirm output-off.");
  return {off:true};
 }
 if(!input.record_kind||!input.record_id)throw new Error("Choose a record to keep this reading.");
 return logBenchReading({
  lookup:(kind,id)=>platform().entities.lookup(orgId,kind,id),
  read:()=>driver.readBench!(),
  save:async value=>{
   let screenshot_file_id:string|null=null;
   const {screenshot,...report}=value.report;
   if(screenshot){
    const bytes=Buffer.from(screenshot.data_b64,"base64");
    const png=scopeScreenshotPng(bytes);
    const file=await platform().files.write(orgId,png,{filename:"scope-reading.png",mimeType:"image/png"});if(!file)throw new Error("Enable Files to keep scope screenshots.");
    screenshot_file_id=file.fileId;
   }
   const saved=await db.insertInto("digifab_bench_readings").values({...value,report:report as typeof value.report,machine_id:input.machine_id,screenshot_file_id}).returningAll().executeTakeFirstOrThrow();
   await platform().activity.log({orgId,userId,action:"instrument-reading_created",ref:{module:"digifab",entityType:"instrument-reading",entityId:saved.id},diff:{record_kind:saved.record_kind,record_id:saved.record_id,report:saved.report}});
   return saved;
  },
  link:async(id,kind,recordId)=>{await platform().pairings.create({orgId,sourceKind:kind,sourceId:recordId,targetKind:"digifab:instrument-reading",targetId:id,relationshipKind:"reading"});},
 },{connection_id:link.connection_id,device_id:link.remote_device_id,record_kind:input.record_kind,record_id:input.record_id});
}
export const benchEntity=(row:{id:string;machine_id:string;report:{identity:string;at:string;readings:{quantity:string;value:number;unit:string}[]};screenshot_file_id:string|null})=>({kind:"digifab:instrument-reading",id:row.id,title:row.report.readings.map(r=>instrumentReadingText(r.value,r.unit)).join(", ") || "Scope screenshot",subtitle:`${row.report.identity} · ${row.report.at}`,detailUrl:openRecordPath("machines:machine",row.machine_id),fields:{identity:row.report.identity,measured_at:row.report.at,readings:row.report.readings,screenshot_file_id:row.screenshot_file_id}});
let registered=false;
export function registerBench(){
 if(registered)return;registered=true;
 platform().entities.registerResolver("digifab:instrument-reading",async(orgId,id)=>{const db=await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;const row=await db.selectFrom("digifab_bench_readings").selectAll().where("id","=",id).executeTakeFirst();return row?benchEntity(row):null;});
 platform().entities.registerListResolver("digifab:instrument-reading",async(orgId,query)=>{const db=await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;let source=db.selectFrom("digifab_bench_readings").selectAll();if(query.q?.trim())source=source.where(eb=>textSearchWhere(eb,query.q,{text:["record_kind"],json:["report"]})!);const rows=await source.orderBy("created_at","desc").orderBy("id","desc").limit(Math.min(query.limit || 20,200)).offset(query.offset || 0).execute();return {items:rows.map(benchEntity)};});
 platform().actions.registerHandler("digifab.instrument",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"A workspace member must read or stop an instrument."};
  try{return {ok:true,data:await runBench(await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,ctx.orgId,ctx.args,ctx.userId)};}catch(error){return {ok:false,error:error instanceof Error?error.message:"The instrument did not answer."};}
 });
}
