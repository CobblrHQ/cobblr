import { type Kysely } from "kysely";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { instrumentReadingText } from "@cobblr/platform-contract/instrument-reading";
import { platform, textSearchWhere } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { buildDriverById } from "./jobs-core.js";
import { BenchRequest, type BenchRequestInput } from "./bench-model.js";
import { scopeScreenshotPng } from "./bench-screenshot.js";
import { discoverBenchESPHome } from "./bench-discovery.js";
import { logBenchReading } from "./bench-log.js";
async function configuredControl(orgId:string,connectionId:string){
 const row=await platform().devices.connections().getInternal(orgId,connectionId);
 if(!row?.credentials_enc)return false;
 const creds=await platform().integrations.decryptCredentials(orgId,row.credentials_enc);
 const edge=creds.edge as Record<string,unknown>|undefined;
 if(!edge||!["riden","esphome-bench"].includes(String(edge.driver)))return false;
 const config=edge.config&&typeof edge.config==="object"?edge.config as Record<string,unknown>:edge;
 return config.control_enabled===true;
}
export async function benchMachine(db:Kysely<DigifabDB>,orgId:string,machineId:string){
 const links=await db.selectFrom("digifab_device_links").selectAll().where("machine_id","=",machineId).execute();
 const instruments=[];
 for(const link of links){
  const driver=await buildDriverById(db,orgId,link.connection_id);if(!driver?.readBench||driver.benchInstrument===false)continue;
  const device=(await driver.listDevices()).find(d=>d.id===link.remote_device_id);
  if(device?.raw?.bench){const bench=device.raw.bench as Record<string,unknown>;device.raw.bench={...bench,control_enabled:await configuredControl(orgId,link.connection_id)};instruments.push({link,driver,device});}
 }
 if(instruments.length>1)throw new Error("Link this machine to one bench instrument before reading it.");
 return instruments[0] || null;
}
export async function runBench(db:Kysely<DigifabDB>,orgId:string,raw:unknown,userId:string|null=null){
 const input:BenchRequestInput=BenchRequest.parse(raw);
 const machine=await benchMachine(db,orgId,input.machine_id);if(!machine)throw new Error("Link this machine to a bridge instrument first.");
 const {driver,link}=machine;
 if(input.operation==="configure"){
  if(!userId||!await platform().auth.userHasRole({orgId,userId,minRole:"owner"}))throw new Error("Only the workspace owner can enable instrument control.");
  if(machine.device.raw?.bench && (machine.device.raw.bench as {profile?:string}).profile!=="riden")throw new Error("Control is available for Riden supplies only.");
  const store=platform().devices.connections(),row=await store.getInternal(orgId,link.connection_id);
  if(!row?.credentials_enc)throw new Error("Configure this instrument through its paired bridge first.");
  const creds=await platform().integrations.decryptCredentials(orgId,row.credentials_enc);
  const edge=creds.edge as Record<string,unknown>;
  if(!edge||!["riden","esphome-bench"].includes(String(edge.driver)))throw new Error("Choose a Riden bridge connection first.");
  const configured=edge.config&&typeof edge.config==="object"?{...edge,config:{...edge.config as Record<string,unknown>,control_enabled:input.control_enabled}}:{...edge,control_enabled:input.control_enabled};
  await store.update(orgId,link.connection_id,{creds:{edge:configured} as unknown as Record<string,string|null>});
  await platform().activity.log({orgId,userId,action:"instrument-control_configured",ref:{module:"digifab",entityType:"instrument",entityId:link.id},diff:{machine_id:input.machine_id,control_enabled:input.control_enabled}});
  return {control_enabled:input.control_enabled!};
 }
 if(["output_on","set_voltage","set_current"].includes(input.operation)){
  const bench=machine.device.raw?.bench as {control_enabled?:boolean}|undefined;
  if(bench?.control_enabled!==true)throw new Error("Control is off for this instrument. The owner can enable it in its settings.");
  await platform().activity.log({orgId,userId,action:"instrument-control_requested",ref:{module:"digifab",entityType:"instrument",entityId:link.id},diff:{machine_id:input.machine_id,operation:input.operation,value:input.value}});
  let result:Awaited<ReturnType<NonNullable<typeof driver.runControl>>>|undefined;
  try{result=await driver.runControl?.(link.remote_device_id,input.operation.replaceAll("_","-"),{confirmed:input.confirmed,value:input.value});}
  finally{await platform().activity.log({orgId,userId,action:"instrument-control_finished",ref:{module:"digifab",entityType:"instrument",entityId:link.id},diff:{machine_id:input.machine_id,operation:input.operation,ok:result?.ok===true}});}
  if(!result?.ok)throw new Error(result?.detail || "The supply did not confirm the change.");
  return {ok:true};
 }
 if(input.operation==="identify"){
  if(!driver.identifyBench)throw new Error("Update the bridge to identify this instrument.");
  return driver.identifyBench();
 }
 if(input.operation==="read")return driver.readBench!();
 if(input.operation==="output_off"){
  const result=await driver.runControl?.(link.remote_device_id,"output-off",{});if(!result?.ok)throw new Error(result?.detail || "The instrument did not confirm output-off.");
  await platform().activity.log({orgId,userId,action:"instrument-output_stopped",ref:{module:"digifab",entityType:"instrument",entityId:link.id},diff:{machine_id:input.machine_id,off:true}});
  return {off:true};
 }
 if(!input.record_kind||!input.record_id)throw new Error("Choose a record to keep this reading.");
 return logBenchReading({
  lookup:(kind,id)=>platform().entities.lookup(orgId,kind,id),
  read:()=>input.operation==="capture"?driver.captureBench?driver.captureBench(input.capture!):Promise.reject(new Error("Update the bridge to capture logic.")):driver.readBench!(),
  save:async value=>{
   let screenshot_file_id:string|null=null,capture_file_id:string|null=null;
   const {screenshot,capture,...reading}=value.report;
   const report={...reading,...(capture?{capture:{decoded:capture.decoded}}:{})};
   if(capture){
    if(!capture.data_b64)throw new Error("The analyser returned no session archive.");
    const bytes=Buffer.from(capture.data_b64,"base64");
    if(bytes.length>2*1024*1024||!bytes.subarray(0,4).equals(Buffer.from([80,75,3,4])))throw new Error("The analyser returned an invalid sigrok session archive.");
    const file=await platform().files.write(orgId,bytes,{filename:"logic-capture.sr",mimeType:"application/zip"});if(!file)throw new Error("Enable Files to keep logic captures.");
    capture_file_id=file.fileId;
   }
   if(screenshot){
    const bytes=Buffer.from(screenshot.data_b64,"base64");
    const png=scopeScreenshotPng(bytes);
    const file=await platform().files.write(orgId,png,{filename:"scope-reading.png",mimeType:"image/png"});if(!file)throw new Error("Enable Files to keep scope screenshots.");
    screenshot_file_id=file.fileId;
   }
   const saved=await db.insertInto("digifab_bench_readings").values({...value,report:report as typeof value.report,machine_id:input.machine_id,screenshot_file_id,capture_file_id}).returningAll().executeTakeFirstOrThrow();
   await platform().activity.log({orgId,userId,action:"instrument-reading_created",ref:{module:"digifab",entityType:"instrument-reading",entityId:saved.id},diff:{record_kind:saved.record_kind,record_id:saved.record_id,report:saved.report}});
   return saved;
  },
  link:async(id,kind,recordId)=>{await platform().pairings.create({orgId,sourceKind:kind,sourceId:recordId,targetKind:"digifab:instrument-reading",targetId:id,relationshipKind:"reading"});},
 },{connection_id:link.connection_id,device_id:link.remote_device_id,record_kind:input.record_kind,record_id:input.record_id});
}
export const benchEntity=(row:{id:string;machine_id:string;report:{identity:string;at:string;readings:{quantity:string;value:number;unit:string}[];capture?:{decoded:string}};screenshot_file_id:string|null;capture_file_id?:string|null})=>({kind:"digifab:instrument-reading",id:row.id,title:row.report.readings.map(r=>instrumentReadingText(r.value,r.unit)).join(", ") || (row.report.capture?"Logic capture":"Scope screenshot"),subtitle:`${row.report.identity} · ${row.report.at}`,detailUrl:openRecordPath("machines:machine",row.machine_id),fields:{identity:row.report.identity,measured_at:row.report.at,readings:row.report.readings,screenshot_file_id:row.screenshot_file_id,capture_file_id:row.capture_file_id,decoded_frames:row.report.capture?.decoded}});
let registered=false;
export function registerBench(){
 if(registered)return;registered=true;
 platform().entities.registerResolver("digifab:instrument-reading",async(orgId,id)=>{const db=await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;const row=await db.selectFrom("digifab_bench_readings").selectAll().where("id","=",id).executeTakeFirst();return row?benchEntity(row):null;});
 platform().entities.registerListResolver("digifab:instrument-reading",async(orgId,query)=>{const db=await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;let source=db.selectFrom("digifab_bench_readings").selectAll();if(query.q?.trim())source=source.where(eb=>textSearchWhere(eb,query.q,{text:["record_kind"],json:["report"]})!);const rows=await source.orderBy("created_at","desc").orderBy("id","desc").limit(Math.min(query.limit || 20,200)).offset(query.offset || 0).execute();return {items:rows.map(benchEntity)};});
 platform().actions.registerHandler("digifab.instrument-stop",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"A workspace member must stop an instrument."};
  try{return {ok:true,data:await runBench(await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,ctx.orgId,{machine_id:ctx.args?.machine_id,operation:"output_off"},ctx.userId)};}catch(error){return {ok:false,error:error instanceof Error?error.message:"The supply did not answer."};}
 });
 platform().actions.registerHandler("digifab.discover-esphome",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"admin"}))return {ok:false,error:"An admin must discover bench devices."};
  return {ok:true,...await discoverBenchESPHome(ctx.orgId,typeof ctx.args?.bridge==="string"?ctx.args?.bridge:null)};
 });
 platform().actions.registerHandler("digifab.instrument-control",async ctx=>{
  if(!["output_on","set_voltage","set_current"].includes(String(ctx.args?.operation)))return {ok:false,error:"Choose a supply control operation."};
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"A workspace member must control an instrument."};
  try{return {ok:true,data:await runBench(await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,ctx.orgId,ctx.args,ctx.userId)};}catch(error){return {ok:false,error:error instanceof Error?error.message:"The supply did not answer."};}
 });
 platform().actions.registerHandler("digifab.instrument",async ctx=>{
  if(!["identify","read","log","capture","configure"].includes(String(ctx.args?.operation)))return {ok:false,error:"Use the dedicated control or stop action for a supply change."};
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"A workspace member must read or stop an instrument."};
  try{return {ok:true,data:await runBench(await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>,ctx.orgId,ctx.args,ctx.userId)};}catch(error){return {ok:false,error:error instanceof Error?error.message:"The instrument did not answer."};}
 });
}
