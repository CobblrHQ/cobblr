import {GcodeSession,type GcodeStream} from "./laser-session.js";
import {emitGcode,emitFrame,GCODE_DIALECTS,parseGrblSettings,validateGcodeController,type GcodeController} from "./laser-gcode.js";
import {LaserSetupSchema,LaserCommissionSchema,type LaserSetup,type LaserCommission} from "@cobblr/platform-contract/laser-setup";
import {validateLaserPlan,type LaserMotionPlan} from "./laser-motion-plan.js";
export interface LaserControllerConfig {firmware:keyof typeof GCODE_DIALECTS;name:string;timeoutMs:number}
export interface LaserControllerTransport {stream:GcodeStream;close:()=>Promise<void>}
export interface LaserControllerIo {
 open:()=>Promise<LaserControllerTransport>;
 hash:(value:string|Uint8Array)=>string;
 uuid:()=>string;
 forgefirmPosition?:()=>Promise<{homed:boolean;driver:string;senderGeneration:number}>;
}
export interface LaserControllerDevice {id:string;name:string;state:string;enabled:boolean;link:"connected"|"idle";raw:Record<string,unknown>;job?:{fractionPrinted:number}}
export interface LaserControllerJobStatus {state:string;progress?:number}
export interface LaserControllerCommandResult {ok:boolean;detail?:string}
const stateOf=(line:string)=>/^<([a-z]+)/i.exec(line)?.[1]?.toLowerCase()??"unknown";
const mapState=(state:string)=>({idle:"idle",run:"printing",hold:"paused",door:"paused",alarm:"error",home:"busy",jog:"busy",sleep:"offline",check:"busy"}[state]??"unknown");
interface Review {fileId:string;contentHash:string;projectHash:string;transport:"compiled";project:Record<string,unknown>;layers:Record<string,unknown>[];cuts:Record<string,unknown>[];materialLibrary:Record<string,unknown>}
interface Prepared {plan:LaserMotionPlan;controller:GcodeController;code:string;review:Review}
interface Job {id:string;state:string;drained:boolean;progress:number;generation:number;detail?:string;stopPending?:boolean}
export class LaserController {
 readonly laserBackend="gcode" as const;
 readonly jobReviewKind="laser" as const;
 private connection:LaserControllerTransport|null=null;
 private session:GcodeSession|null=null;
 private opening:Promise<GcodeSession>|null=null;
 private prepared:Prepared|null=null;
 private active:Job|null=null;
 private jobs=new Map<string,Job>();
 private busy=false;
 private generation=0;
 private homed=false;
 private sessionId:string;
 private commissioning:LaserCommission|null=null;
 private senderGeneration:number|null=null;
 private homingSettingsHash:string|null=null;
 private homingIdentityHash:string|null=null;
 private disposed=false;
 private closing:Promise<void>|null=null;
 constructor(private config:LaserControllerConfig,private io:LaserControllerIo){this.sessionId=io.uuid();}
 private async connect():Promise<GcodeSession>{
  if(this.disposed)throw new Error("This laser connection was removed.");
  if(this.session)return this.session;if(this.opening)return this.opening;
  this.opening=(async()=>{
   const connection=await this.io.open();
   if(this.disposed){await connection.close();throw new Error("This laser connection was removed.");}
   this.connection=connection;
   const session=new GcodeSession(connection.stream,this.config.timeoutMs,127,this.config.firmware==="forgefirm"?305000:this.config.timeoutMs,this.config.firmware==="marlin"?"marlin":this.config.firmware==="snapmaker"?"snapmaker":this.config.firmware==="smoothieware"?"smoothieware":"grbl");
   session.on("fault",(error:Error)=>this.loseController(error.message));
   session.on("reset",()=>this.loseController("The controller restarted. Check its position and prepare a fresh review."));
   session.on("progress",(fraction:number)=>{if(this.active&&this.active.generation===this.generation&&!['cancelled','failed'].includes(this.active.state))this.active.progress=fraction;});
   connection.stream.once("close",()=>{if(this.session===session){this.session=null;this.connection=null;this.loseController("The controller disconnected. Check the piece before preparing another job.");}});
   this.session=session;return session;
  })().finally(()=>{this.opening=null;});return this.opening;
 }
 private loseController(reason:string):void{
  this.generation++;this.invalidateSetup();
  if(this.active&&!this.active.stopPending){this.active.state="failed";this.active.detail=reason;this.active=null;}
 }
 private invalidateSetup():void{this.homed=false;this.homingSettingsHash=null;this.homingIdentityHash=null;this.commissioning=null;this.senderGeneration=null;this.prepared=null;this.sessionId=this.io.uuid();}
 private async grblSettings(session:GcodeSession):Promise<string>{
  let settings=await session.command("$$");if(this.config.firmware==="fluidnc"&&!/^\$31=/m.test(settings))settings+="\n$31=0";
  if(this.homingSettingsHash!==null&&this.io.hash(settings)!==this.homingSettingsHash)this.invalidateSetup();
  return settings;
 }
 async getLaserSetup():Promise<LaserSetup>{
  this.ensureAvailable();this.busy=true;const generation=this.generation;
  try{return await this.readSetup(generation);}finally{this.busy=false;}
 }
 private async readMarlinSetup(generation:number):Promise<LaserSetup>{
  const session=await this.connect();if(stateOf(await session.status())!=="idle")throw new Error("Finish the controller's stored job before station setup.");
  const identity=await session.command("M115"),settings=await session.command("M503");this.ensureGeneration(generation);
  const identityHash=this.io.hash(identity),settingsHash=this.io.hash(settings);
  if((this.homingIdentityHash!==null&&identityHash!==this.homingIdentityHash)||(this.homingSettingsHash!==null&&settingsHash!==this.homingSettingsHash))this.invalidateSetup();
  const saved=this.commissioning?.firmware==="marlin"?this.commissioning:null;
  const commissioned=!!saved&&saved.sessionId===this.sessionId&&saved.identityHash===identityHash&&saved.settingsHash===settingsHash;
  if(saved&&!commissioned)this.invalidateSetup();
  const laserMode=/^Cap:LASER:1$/m.test(identity),emergencyParser=/^Cap:EMERGENCY_PARSER:1$/m.test(identity);
  return LaserSetupSchema.parse({sessionId:this.sessionId,identityHash,settingsHash,firmware:"marlin",state:"idle",laserMode,powerMax:commissioned?(saved!.powerUnit==="PWM"?255:100):null,powerMin:0,needsHoming:true,homed:this.homed,canHome:laserMode&&emergencyParser,needsCommissioning:true,commissioned,facts:[identity,"Marlin must report LASER and EMERGENCY_PARSER capability. Confirm inline M3 I / G1 S power and CUTTER_POWER_UNIT from its build configuration.","Pause drains planned moves and turns the beam off. Stop shuts down the controller; restart it before reconnecting and homing again."]});
 }
 private async readSmoothieSetup(generation:number):Promise<LaserSetup>{
  const session=await this.connect();if(stateOf(await session.status())!=="idle")throw new Error("The laser must report idle before station setup.");
  const identity=await session.command("M115");if(!/FIRMWARE_NAME:Smoothieware/i.test(identity))throw new Error("The controller did not identify Smoothieware.");
  const keys={grbl_mode:"false",laser_module_enable:"false",laser_module_maximum_s_value:"1",laser_module_minimum_power:"0",laser_module_tickle_power:"0",laser_module_maximum_power:"1"};
  const settings:Record<string,string>={};
  for(const [key,fallback] of Object.entries(keys)){
   const reply=await session.command(`config-get ${key}`);
   const value=new RegExp(`^cached: ${key} is set to (\\S+)\\s*$`,"m").exec(reply)?.[1];
   if(value===undefined&&!reply.includes(`cached: ${key} is not in config`))throw new Error("Smoothieware did not report its laser configuration.");
   settings[key]=value??fallback;
  }
  const scale=await session.command("M221");
  if(!/Laser power:\s*100(?:\.0+)?\s*%, disable auto power:\s*0,/.test(scale))throw new Error("Set Smoothieware laser scaling to 100 percent with automatic power enabled before station setup.");
  this.ensureGeneration(generation);
  const identityHash=this.io.hash(identity),settingsHash=this.io.hash(JSON.stringify({settings,scale}));
  if((this.homingIdentityHash!==null&&this.homingIdentityHash!==identityHash)||(this.homingSettingsHash!==null&&this.homingSettingsHash!==settingsHash))this.invalidateSetup();
  const powerMax=Number(settings.laser_module_maximum_s_value),powerMin=Math.max(Number(settings.laser_module_minimum_power),Number(settings.laser_module_tickle_power)),maximum=Number(settings.laser_module_maximum_power);
  if(!Number.isFinite(powerMax)||powerMax<=0||!Number.isFinite(powerMin)||powerMin!==0||!Number.isFinite(maximum)||maximum<=0||maximum>1)throw new Error("Check Smoothieware's laser range and disable minimum or keepalive power before motion.");
  const laserMode=settings.grbl_mode==="true"&&/X-GRBL_MODE:1(?:,|$)/.test(identity)&&settings.laser_module_enable==="true";
  const saved=this.commissioning,commissioned=saved?.firmware==="smoothieware"&&saved.sessionId===this.sessionId&&saved.identityHash===identityHash&&saved.settingsHash===settingsHash;
  if(saved&&!commissioned)this.invalidateSetup();
  return LaserSetupSchema.parse({sessionId:this.sessionId,identityHash,settingsHash,firmware:"smoothieware",state:"idle",laserMode,powerMax,powerMin:0,needsHoming:true,homed:this.homed,canHome:laserMode,needsCommissioning:true,commissioned:!!commissioned,facts:[identity,"Configuration reads come from the saved file. Restart after editing it, then confirm here. Home is explicit; Stop leaves the controller halted until you clear it at the machine.","Pause drains planned moves and switches off manual firing before Resume. Air assist needs explicit M8 and M9 configuration."]});
 }
 private async readSnapmakerSetup(generation:number):Promise<LaserSetup>{
  const session=await this.connect();if(stateOf(await session.status())!=="idle")throw new Error("Finish Snapmaker's stored job before station setup.");
  const firmware=await session.command("M115"),identity=await session.command("M1005"),head=await session.command("M1006"),position=await session.command("M1007"),settings=await session.command("M503");this.ensureGeneration(generation);
  if(!firmware.trim()||!identity.trim())throw new Error("Snapmaker did not report its firmware identity.");
  const toolhead=/^Tool Head:\s*(.+)$/m.exec(head)?.[1]?.trim();if(!toolhead)throw new Error("Snapmaker did not report its toolhead.");
  const laserMode=/^(?:\d+W (?:RED )?)?LASER$/.test(toolhead);
  const coordinates=position.split("\n").filter(line=>!line.startsWith("Homed:")).join("\n");
  const identityHash=this.io.hash(JSON.stringify({firmware,identity,toolhead})),settingsHash=this.io.hash(JSON.stringify({settings,coordinates}));
  if((this.homingIdentityHash!==null&&this.homingIdentityHash!==identityHash)||(this.homingSettingsHash!==null&&this.homingSettingsHash!==settingsHash))this.invalidateSetup();
  if(!/^Homed: (YES|NO)$/m.test(position)||!/^Selected == Current: YES$/m.test(position))throw new Error("Check Snapmaker's coordinate system at the machine before continuing.");
  const homed=this.homed&&/^Homed: YES$/m.test(position);
  return LaserSetupSchema.parse({sessionId:this.sessionId,identityHash,settingsHash,firmware:"snapmaker",state:"idle",laserMode,powerMax:100,powerMin:0,needsHoming:true,homed,canHome:laserMode,needsCommissioning:false,commissioned:true,facts:[`Toolhead: ${toolhead}.`,"Home turns off the beam, then homes the machine's axes. Clear the bed first. Check the configured sheet origin with Frame before Start.","Power uses M3 P percentages. Air assist is manual. Pause drains planned motion and switches the beam off; Stop sends M112 and requires a controller restart before Home."]});
 }
 private async readSetup(generation:number):Promise<LaserSetup>{
  if(this.config.firmware==="marlin")return this.readMarlinSetup(generation);
  if(this.config.firmware==="smoothieware")return this.readSmoothieSetup(generation);
  if(this.config.firmware==="snapmaker")return this.readSnapmakerSetup(generation);
  if(!["grbl","grbl-lpc","grblhal","fluidnc","forgefirm"].includes(this.config.firmware))throw new Error("This firmware needs its own configuration report.");
  const session=await this.connect(),state=stateOf(await session.status());
  if(state!=="idle")throw new Error("The laser must report idle before station setup.");
  const identity=await session.command("$I");if(!identity.trim())throw new Error("The controller did not report its firmware identity.");
  if(this.config.firmware!=="forgefirm"&&this.homingIdentityHash!==null&&this.io.hash(identity)!==this.homingIdentityHash)this.invalidateSetup();
  const settings=await this.grblSettings(session),controller=parseGrblSettings(settings);this.ensureGeneration(generation);
  let positionHomed=this.homed,identityHash=this.io.hash(identity);
  if(this.config.firmware==="forgefirm"){
   if(!this.io.forgefirmPosition)throw new Error("Add the ForgeFIRM HTTPS panel address and pinned certificate fingerprint to this machine connection.");
   const position=await this.io.forgefirmPosition();this.ensureGeneration(generation);
   if(this.senderGeneration!==null&&this.senderGeneration!==position.senderGeneration)this.invalidateSetup();
   this.senderGeneration=position.senderGeneration;positionHomed=position.homed;
   identityHash=this.io.hash(JSON.stringify({identity,driver:position.driver,senderGeneration:position.senderGeneration}));
  }
  const commissioned=!!this.commissioning&&this.commissioning.sessionId===this.sessionId&&this.commissioning.identityHash===identityHash&&this.commissioning.settingsHash===this.io.hash(settings);
  if(this.commissioning&&!commissioned)this.invalidateSetup();
  return LaserSetupSchema.parse({sessionId:this.sessionId,identityHash,settingsHash:this.io.hash(settings),firmware:this.config.firmware,state:"idle",laserMode:controller.laserMode,powerMax:controller.powerMax,powerMin:controller.powerMin,needsHoming:controller.homing||this.config.firmware==="forgefirm",homed:positionHomed,canHome:controller.homing||this.config.firmware==="forgefirm",needsCommissioning:this.config.firmware==="forgefirm",commissioned:this.config.firmware!=="forgefirm"||commissioned,facts:[identity,"Home is explicit. Stop, disconnect or changed settings require a fresh position check."]});
 }
 async commissionLaser(input:LaserCommission):Promise<LaserSetup>{
  const configuration=LaserCommissionSchema.parse(input);
  if(configuration.firmware!==this.config.firmware)throw new Error("Confirm the firmware selected for this connection.");
  this.ensureAvailable();this.busy=true;this.prepared=null;const generation=this.generation;
  try{
   const report=await this.readSetup(generation);this.ensureGeneration(generation);
   if(configuration.sessionId!==report.sessionId||configuration.identityHash!==report.identityHash||configuration.settingsHash!==report.settingsHash)throw new Error("The controller changed. Check setup again before confirming it.");
   if(configuration.firmware==="marlin"&&!report.canHome)throw new Error("Marlin must report LASER and EMERGENCY_PARSER capability before confirmation or Home.");
   this.commissioning=configuration;return {...report,commissioned:true,...(configuration.firmware==="marlin"?{powerMax:configuration.powerUnit==="PWM"?255:100}:{})};
  }finally{this.busy=false;}
 }
 async homeLaser():Promise<LaserSetup>{
  this.ensureAvailable();this.busy=true;this.prepared=null;const generation=this.generation;
  try{
   const before=await this.readSetup(generation);if(!before.canHome)throw new Error("Enable controller homing before using Home. ForgeFIRM needs its own live position report.");
   const session=await this.connect();this.ensureGeneration(generation);if(this.config.firmware==="marlin")await session.command("M5 I");
   if(this.config.firmware==="snapmaker")await session.command("M5");
   if(this.config.firmware==="smoothieware"){await session.command("M400");await session.command("fire off");}this.ensureGeneration(generation);await session.command(this.config.firmware==="marlin"?"G28 X Y":this.config.firmware==="snapmaker"?"G28":"$H",60000);this.ensureGeneration(generation);
   const after=await this.readSetup(generation);
   if(after.sessionId!==before.sessionId||after.identityHash!==before.identityHash||after.settingsHash!==before.settingsHash)throw new Error("The controller changed during Home. Check it before continuing.");
   if(this.config.firmware==="snapmaker"&&!/^Homed: YES$/m.test(await session.command("M1007")))throw new Error("Snapmaker did not confirm Home.");
   this.ensureGeneration(generation);
   if(this.config.firmware==="forgefirm"&&!after.homed)throw new Error("ForgeFIRM did not confirm a homed position. Check its panel before continuing.");
   this.homed=true;this.homingSettingsHash=after.settingsHash;this.homingIdentityHash=after.identityHash;return {...after,homed:true};
  }finally{this.busy=false;}
 }
 private async controller():Promise<GcodeController>{
  if(this.config.firmware==="snapmaker"){
   const report=await this.readSetup(this.generation),session=await this.connect(),head=await session.command("M1006");
   if(!/^Tool Head:\s*(?:\d+W (?:RED )?)?LASER\s*$/m.test(head))throw new Error("Snapmaker no longer reports a laser toolhead. Check its setup again.");
   if(!/^Current Status: OFF$/m.test(head))throw new Error("Switch off Snapmaker's beam before Frame or Start.");
   const controller={firmware:this.config.firmware,powerMax:100,powerMin:0,laserMode:report.laserMode,homing:true,homed:report.homed};validateGcodeController(controller);return controller;
  }
  if(this.config.firmware==="smoothieware"){
   const report=await this.readSetup(this.generation);if(!report.commissioned)throw new Error("Confirm Smoothieware restarted after its configuration changed before Frame or Start.");
   const controller={firmware:this.config.firmware,powerMax:report.powerMax!,powerMin:0,laserMode:report.laserMode,homing:true,homed:report.homed,coolant:this.commissioning?.firmware==="smoothieware"&&this.commissioning.coolantConfirmed};validateGcodeController(controller);return controller;
  }
  if(this.config.firmware==="marlin"){
   const report=await this.readSetup(this.generation);
   if(!report.commissioned)throw new Error("Confirm Marlin's inline laser mode and power units at its station before Frame or Start.");
   const controller={firmware:this.config.firmware,powerMax:report.powerMax!,powerMin:0,laserMode:report.laserMode,homing:true,homed:report.homed,inlinePower:true,coolant:this.commissioning?.firmware==="marlin"&&this.commissioning.coolantConfirmed};validateGcodeController(controller);return controller;
  }
  if(this.config.firmware==="forgefirm"){
   const report=await this.readSetup(this.generation);
   if(!report.commissioned)throw new Error("Confirm that ForgeFIRM restarted after its spindle settings changed before Frame or Start.");
   const controller={firmware:this.config.firmware,powerMax:report.powerMax!,powerMin:report.powerMin!,laserMode:report.laserMode,homing:true,homed:report.homed};validateGcodeController(controller);return controller;
  }
  const session=await this.connect();
  if(stateOf(await session.status())!=="idle")throw new Error("The laser must report idle before Frame or Start.");
  if(!["grbl","grbl-lpc","grblhal","fluidnc","forgefirm"].includes(this.config.firmware))throw new Error("This firmware must report its verified laser configuration before Frame or Start.");
  if(this.homingIdentityHash!==null&&this.io.hash(await session.command("$I"))!==this.homingIdentityHash)this.invalidateSetup();
  const settings=await this.grblSettings(session);
  const controller={...parseGrblSettings(settings),firmware:this.config.firmware,homed:this.homed};
  validateGcodeController(controller);return controller;
 }
 private ensureAvailable():void{if(this.busy||this.active)throw new Error("This laser is already preparing or running a job.");}
 private ensureGeneration(generation:number):void{if(generation!==this.generation)throw new Error("The laser was stopped. Prepare a fresh review before Start.");}
 private review(source:Uint8Array,plan:LaserMotionPlan,controller:GcodeController,code:string):Review {
  const projectHash=this.io.hash(JSON.stringify({source:new TextDecoder().decode(source),controller,code}));
  return {fileId:`laser-${projectHash}`,contentHash:this.io.hash(source),projectHash,transport:"compiled",project:{backend:"gcode",firmware:controller.firmware,origin:plan.origin,bounds:plan.bounds,controller,units:{distance:"mm",speed:"mm/s"}},layers:plan.layers.map(l=>({index:l.index,name:l.layer,in_use:true})),cuts:plan.layers.map(l=>({index:l.index,layer_index:l.index,enabled:true,mode:l.operation==="engrave"?"Fill":"Line",params:{speed:l.speed,min_power:l.min_power,max_power:l.max_power,num_passes:l.passes,air_assist:l.air_assist,z_offset:l.focus_offset}})),materialLibrary:{}};
 }
 async prepareJob(source:Uint8Array,_filename:string):Promise<Review>{
  this.ensureAvailable();this.busy=true;this.prepared=null;const generation=this.generation;
  try{
   if(source.length>20*1024*1024)throw new Error("Make a laser plan smaller than 20 MB.");
   const plan=validateLaserPlan(JSON.parse(new TextDecoder().decode(source))),controller=await this.controller(),code=emitGcode(plan,controller);
   const review=this.review(source,plan,controller,code);this.ensureGeneration(generation);this.prepared={plan,controller,code,review};return structuredClone(review);
  }finally{this.busy=false;}
 }
 async uploadFile():Promise<never>{throw new Error("Review and approve this laser job at its authorized station before Start.");}
 private async reviewed(fileId:string):Promise<Prepared>{
  const saved=this.prepared;if(!saved||saved.review.fileId!==fileId)throw new Error("This laser review expired. Prepare the job again.");
  const generation=this.generation,controller=await this.controller();this.ensureGeneration(generation);
  if(JSON.stringify(controller)!==JSON.stringify(saved.controller)){this.prepared=null;throw new Error("The controller's laser settings changed. Prepare the job again.");}
  return saved;
 }
 async getJobReview(fileId:string):Promise<Review>{this.ensureAvailable();return structuredClone((await this.reviewed(fileId)).review);}
 async submitJob(fileId:string,target:string|null,approval?:{projectHash:string}):Promise<{jobId:string;queued:boolean}>{
  this.ensureAvailable();if(target&&target!=="gcode-laser")throw new Error("This bridge instance fronts a different laser.");
  if(!approval||this.prepared?.review.fileId!==fileId||approval.projectHash!==this.prepared.review.projectHash)throw new Error("Review and approve this laser job at its authorized station before Start.");
  this.busy=true;const generation=this.generation;
  try{
   const saved=await this.reviewed(fileId),session=await this.connect();this.ensureGeneration(generation);this.prepared=null;
   const job:Job={id:this.io.uuid(),state:"queued",drained:false,progress:0,generation};this.active=job;this.jobs.set(job.id,job);
   while(this.jobs.size>16)this.jobs.delete(this.jobs.keys().next().value!);
   void session.run(saved.code+(["marlin","snapmaker","smoothieware"].includes(this.config.firmware)?"M400\n":"G4 P0.01\n")).then(()=>{if(job.state!=="cancelled"&&!job.stopPending){job.drained=true;}}).catch((e:unknown)=>{if(job.state!=="cancelled"&&!job.stopPending){job.state="failed";job.detail=e instanceof Error?e.message:"The controller could not finish the job.";this.active=null;}});
   return {jobId:job.id,queued:true};
  }finally{this.busy=false;}
 }
 async getJobStatus(jobId:string):Promise<LaserControllerJobStatus>{
  const job=this.jobs.get(jobId);if(!job)return {state:"unknown"};
  if(job.stopPending)return {state:"unknown",progress:job.progress};
  if(["cancelled","failed","completed"].includes(job.state))return {state:job.state,progress:job.progress};
  try{
   const state=stateOf(await (await this.connect()).status());
   if(job.generation!==this.generation||["cancelled","failed","completed"].includes(job.state))return {state:job.state,progress:job.progress};
   if(state==="idle"&&job.drained){job.state="completed";job.progress=1;if(this.active===job)this.active=null;}
   else if(state==="run")job.state="printing";else if(state==="hold"||state==="door")job.state="paused";else if(state!=="idle")return {state:"unknown",progress:job.progress};
   return {state:job.state,progress:job.progress};
  }catch{return {state:"unknown",progress:job.progress};}
 }
 async listDevices():Promise<LaserControllerDevice[]>{
  try{const session=await this.connect(),state=mapState(stateOf(await session.status()));return [{id:"gcode-laser",name:this.config.name,state,enabled:state!=="unknown",link:"connected",raw:{laserBackend:this.laserBackend,laserSetup:true,firmware:this.config.firmware},...(this.active?{job:{fractionPrinted:this.active.progress}}:{})}];}
  catch{return [{id:"gcode-laser",name:this.config.name,state:"offline",enabled:false,link:"idle",raw:{laserBackend:this.laserBackend,laserSetup:true,firmware:this.config.firmware}}];}
 }
 listControls(){return [{id:"frame",label:"Frame",kind:"action" as const,group:"motion" as const},{id:"pause",label:"Pause",kind:"action" as const,group:"print" as const},{id:"resume",label:"Resume",kind:"action" as const,group:"print" as const},{id:"stop",label:"Stop",kind:"action" as const,group:"print" as const}];}
 async runControl(id:string,params:Record<string,unknown>):Promise<LaserControllerCommandResult>{
  try{
   if(id==="stop"||id==="cancel"){
    // Nothing more is sent from here on, but the job is cancelled only once the
    // controller confirms Stop: until then it reads unknown and stays the active
    // job, so pressing Stop again confirms this same job on a fresh connection.
    const job=this.active;this.generation++;this.invalidateSetup();
    if(job){job.state="unknown";job.stopPending=true;}
    try{await (await this.connect()).stop();}
    catch{await this.dropSession();return {ok:false,detail:"The controller did not confirm Stop. Check the machine, then press Stop again."};}
    if(["marlin","snapmaker","smoothieware"].includes(this.config.firmware))await this.connection?.close();
    if(job){job.state="cancelled";job.stopPending=false;if(this.active===job)this.active=null;}
    return {ok:true};
   }
   if(id==="pause"||id==="resume"){
    if(!this.active||["cancelled","failed","completed"].includes(this.active.state))throw new Error("This laser has no active job to pause or resume.");
    if(this.active.stopPending)throw new Error("Stop was not confirmed. Press Stop again.");
    const session=await this.connect();if(id==="pause")await session.pause();else await session.resume();return {ok:true};
   }
   if(id!=="frame")return {ok:false,detail:"This laser control is unavailable."};
   this.ensureAvailable();this.busy=true;const generation=this.generation;
   try{
    const saved=await this.reviewed(String(params.fileId??"")),session=await this.connect();this.ensureGeneration(generation);
    await session.run(emitFrame(saved.plan,saved.controller.firmware)+(["marlin","snapmaker","smoothieware"].includes(this.config.firmware)?"M400\n":"G4 P0.01\n"));this.ensureGeneration(generation);return {ok:true};
   }finally{this.busy=false;}
  }catch(e){return {ok:false,detail:e instanceof Error?e.message:"The laser did not accept the control."};}
 }
 private async dropSession():Promise<void>{
  const session=this.session,connection=this.connection;this.session=null;this.connection=null;
  await session?.close().catch(()=>{});await connection?.close().catch(()=>{});
 }
 close():Promise<void>{
  if(this.closing)return this.closing;
  this.disposed=true;this.generation++;this.prepared=null;this.homed=false;
  this.closing=(async()=>{
   const job=this.active;this.active=null;
   if(job){job.state="unknown";job.stopPending=true;}
   await this.opening?.catch(()=>{});
   const session=this.session,connection=this.connection;
   let confirmed=false;try{if(session){await session.stop();confirmed=true;}}catch{}
   if(job&&confirmed){job.state="cancelled";job.stopPending=false;}
   await session?.close();await connection?.close();this.session=null;this.connection=null;
  })();return this.closing;
 }
}
