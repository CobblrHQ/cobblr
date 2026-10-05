import { createHash } from "node:crypto";
import { DeclarativeDriver } from "./declarative.js";
import { DriverSaid } from "../job-truth.js";
import type { JobReview, SubmitArgs, SubmitResult, RemoteDevice, ControlDef, CommandResult } from "./types.js";
import { emitGcode, emitFrame, parseGrblSettings, validateGcodeController, type GcodeController } from "../laser-gcode.js";
import { validateLaserPlan, type LaserMotionPlan } from "../laser-motion-plan.js";
const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const HEADER=";Cobblr:";
export class DirectLaserDriver extends DeclarativeDriver {
 readonly laserBackend="gcode" as const;
 async jobReviewRequired():Promise<boolean>{return true;}
 private async text(path:string,vars:Record<string,string>={}):Promise<string>{
  const r=await this.req("GET",this.path(path,vars));
  if(!r.ok)throw new DriverSaid(r.status,"The laser controller did not answer. Check the connection and try again.");
  const text=await r.text();if(text.length>20*1024*1024)throw new DriverSaid(409,"The laser reply is too large.");return text;
 }
 private async command(command:string):Promise<void>{
  const reply=await this.text(this.manifest.laser!.command,{command});
  if(/(?:^|\n)(?:error:|ALARM:)|\[MSG:ERR:/i.test(reply))throw new DriverSaid(409,"The controller refused the command. Check its screen before continuing.");
 }
 private async controller():Promise<GcodeController>{
  const l=this.manifest.laser!;
  const text=await this.text(l.settings);
  let values:Omit<GcodeController,"firmware"|"homed">;
  if(l.firmware==="fluidnc")values=parseGrblSettings(/^\$31=/m.test(text)?text:text+"\n$31=0\n");
  else if(["grbl","grbl-lpc","grblhal","forgefirm"].includes(l.firmware))values=parseGrblSettings(text);
  else {
   const c=JSON.parse(text) as Record<string,unknown>;
   if(typeof c.powerMax!=="number"||typeof c.powerMin!=="number"||typeof c.laserMode!=="boolean"||typeof c.homing!=="boolean")throw new DriverSaid(409,"The controller did not report its laser configuration.");
   values={powerMax:c.powerMax,powerMin:c.powerMin,laserMode:c.laserMode,homing:c.homing,...(l.firmware==="marlin"?{inlinePower:c.inlinePower===true,coolant:c.coolant===true}:{})};
  }
  const homed=(values.homing||l.firmware==="forgefirm")&&l.homed?new RegExp(l.homed.pattern).test(await this.text(l.homed.path)):false;
  const c={...values,firmware:l.firmware,homed};validateGcodeController(c);return c;
 }
 private async preflight():Promise<GcodeController>{
  const c=await this.controller();const devices=await this.listDevices();
  if(devices.length!==1||devices[0]?.state!=="idle")throw new DriverSaid(409,"The laser must report idle before Frame or Start.");return c;
 }
 override async listDevices():Promise<RemoteDevice[]>{
  const m=this.manifest.status;if(!m)throw new Error("The direct laser needs a status endpoint.");
  const text=await this.text(m.path,{jobId:""});const state=/<(\w+)/.exec(text)?.[1]?.toLowerCase();
  const map:Record<string,string>={idle:"idle",run:"printing",hold:"paused",door:"paused",alarm:"error",home:"busy",jog:"busy",sleep:"offline",check:"busy"};
  return [{id:this.manifest.id,name:this.manifest.name,state:map[state??""]??"unknown",enabled:true,raw:{laserBackend:this.laserBackend}}];
 }
 private compiled(source:string,c:GcodeController):string {
  const plan=validateLaserPlan(JSON.parse(source));const code=emitGcode(plan,c);
  const header=Buffer.from(JSON.stringify({source,controller:c})).toString("base64").match(/.{1,64}/g)??[];
  const file=header.map(line=>HEADER+line).join("\n")+"\n"+code;
  if(Buffer.byteLength(file)>20*1024*1024)throw new DriverSaid(409,"This compiled job is over 20 MB. Make a smaller batch.");return file;
 }
 private review(source:string,c:GcodeController,fileId:string):JobReview {
  const plan=validateLaserPlan(JSON.parse(source));const code=this.compiled(source,c);
  return {fileId,contentHash:hash(source),projectHash:hash(code),transport:"compiled",project:{backend:"gcode",firmware:c.firmware,units:{distance:"mm",speed:"mm/s"},origin:plan.origin,bounds:plan.bounds,controller:c},layers:plan.layers.map(l=>({index:l.index,name:l.layer,in_use:true})),cuts:plan.layers.map(l=>({index:l.index,layer_index:l.index,enabled:true,mode:l.operation==="engrave"?"Fill":"Line",params:{speed:l.speed,min_power:l.min_power,max_power:l.max_power,num_passes:l.passes,air_assist:l.air_assist,z_offset:l.focus_offset}})),materialLibrary:{}};
 }
 async prepareJob(file:Uint8Array,_filename:string):Promise<JobReview>{
  const source=Buffer.from(file).toString("utf8");const c=await this.preflight();
  const code=this.compiled(source,c),name=`laser-${hash(code)}.gcode`;
  const up=await super.uploadFile(Buffer.from(code),name);
  const review=await this.getJobReview(up.fileId);
  if(review.contentHash!==hash(file)||review.projectHash!==hash(code))throw new DriverSaid(409,"The controller stored a different laser file. Nothing was started.");return review;
 }
 private async loaded(fileId:string):Promise<{source:string;controller:GcodeController;plan:LaserMotionPlan}>{
  if(!/^laser-[a-f0-9]{64}\.gcode$/.test(fileId))throw new DriverSaid(409,"Review a compiled laser job before Start.");
  const code=await this.text(this.manifest.laser!.download,{fileId});const lines=code.split("\n"),header:string[]=[];
  while(lines[0]?.startsWith(HEADER))header.push(lines.shift()!.slice(HEADER.length));
  const saved=JSON.parse(Buffer.from(header.join(""),"base64").toString("utf8")) as {source:string;controller:GcodeController};
  const plan=validateLaserPlan(JSON.parse(saved.source));
  if(this.compiled(saved.source,saved.controller)!==code||fileId!==`laser-${hash(code)}.gcode`)throw new DriverSaid(409,"The stored laser file changed. Review it again before Start.");
  return {...saved,plan};
 }
 private async reviewedController(saved:GcodeController):Promise<GcodeController>{
  const c=await this.preflight();
  if(JSON.stringify(c)!==JSON.stringify(saved))throw new DriverSaid(409,"The controller's laser settings changed. Prepare the job again.");
  return c;
 }
 async getJobReview(fileId:string):Promise<JobReview>{
  const saved=await this.loaded(fileId),c=await this.reviewedController(saved.controller);
  return this.review(saved.source,c,fileId);
 }
 override async uploadFile():Promise<never>{throw new DriverSaid(409,"Review and approve this laser job at its station before Start.");}
 override async submitJob(args:SubmitArgs):Promise<SubmitResult>{
  if(!args.approval||args.approval.fileId!==args.fileId)throw new DriverSaid(409,"Review and approve this laser job at its station before Start.");
  const review=await this.getJobReview(args.fileId);
  if(review.projectHash!==args.approval.projectHash)throw new DriverSaid(409,"The compiled job changed. Review it again.");
  await args.checkStartAllowed?.();
  await this.command(`$SD/Run=/${args.fileId}`);
  try { await args.checkStartAllowed?.(); }
  catch { await this.command("\x18"); await this.command("M5"); throw new DriverSaid(409, "The laser was stopped while Start was being acknowledged. Check the piece before preparing another job."); }
  return { jobId: args.fileId, deviceId: args.deviceId ?? this.manifest.id, queued: true, status: "queued" };
 }
 override listControls():ControlDef[]{return [{id:"pause",label:"Pause",kind:"action",group:"print"},{id:"resume",label:"Resume",kind:"action",group:"print"},{id:"stop",label:"Stop",kind:"action",group:"print"},{id:"frame",label:"Frame",kind:"action",group:"motion"}];}
 override async runCommand(id:string,params:Record<string,unknown>):Promise<CommandResult>{return this.runControl(this.manifest.id,id,params);}
 override async runControl(_deviceId:string,id:string,params:Record<string,unknown>):Promise<CommandResult>{
  try {
   if(id==="pause")await this.command("!");
   else if(id==="resume")await this.command("~");
   else if(id==="stop"||id==="cancel"){await this.command("\x18");await this.command("M5");}
   else if(id==="frame"){
    const fileId=String(params.fileId??"");const saved=await this.loaded(fileId);await this.reviewedController(saved.controller);
    const code=emitFrame(saved.plan,saved.controller.firmware),name=`frame-${hash(code)}.gcode`;
    await super.uploadFile(Buffer.from(code),name);
    const check=typeof params.checkMotionAllowed==="function"?params.checkMotionAllowed as ()=>Promise<void>:undefined;
    await check?.();await this.command(`$SD/Run=/${name}`);
    try{await check?.();}catch(e){await this.command("\x18");await this.command("M5");throw e;}
   }else return {ok:false,detail:"This laser control is unavailable."};
   return {ok:true};
  }catch(e){return {ok:false,detail:e instanceof Error?e.message:"The laser did not accept the control."};}
 }
}
