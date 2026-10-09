export interface GcodeStream {
 on(event:"data",listener:(data:Uint8Array)=>void):unknown;
 on(event:"error",listener:(error:Error)=>void):unknown;
 on(event:"close",listener:()=>void):unknown;
 once(event:"close",listener:()=>void):unknown;
 write(bytes:string|Uint8Array,callback?:(error?:Error|null)=>void):unknown;
 destroy(error?:Error):unknown;
}
interface SessionEvents {fault:Error;reset:string;status:string;progress:number;drain:string;halt:string}
class SessionEmitter {
 private listeners=new Map<keyof SessionEvents,Set<{call:(value:never)=>void;once:boolean}>>();
 on<K extends keyof SessionEvents>(event:K,call:(value:SessionEvents[K])=>void):this{return this.add(event,call,false);}
 once<K extends keyof SessionEvents>(event:K,call:(value:SessionEvents[K])=>void):this{return this.add(event,call,true);}
 private add<K extends keyof SessionEvents>(event:K,call:(value:SessionEvents[K])=>void,once:boolean):this{
  const listeners=this.listeners.get(event)||new Set();listeners.add({call:call as (value:never)=>void,once});this.listeners.set(event,listeners);return this;
 }
 off<K extends keyof SessionEvents>(event:K,call:(value:SessionEvents[K])=>void):this{
  const listeners=this.listeners.get(event);for(const entry of listeners||[])if(entry.call===call)listeners!.delete(entry);return this;
 }
 protected emit<K extends keyof SessionEvents>(event:K,value:SessionEvents[K]):void{
  const listeners=this.listeners.get(event);for(const entry of [...listeners||[]]){if(entry.once)listeners!.delete(entry);entry.call(value as never);}
 }
}
const byteLength=(value:string)=>new TextEncoder().encode(value).length;

interface Pending { program:boolean; bytes:number; reply:string[]; replyBytes:number; timeoutMs:number; resolve:(reply:string)=>void; reject:(error:Error)=>void }
export class GcodeSession extends SessionEmitter {
 private input="";
 private pending:Pending[]=[];
 private used=0;
 private program:{lines:string[];next:number;acked:number;resolve:()=>void;reject:(error:Error)=>void}|null=null;
 private deadline:ReturnType<typeof setTimeout>|null=null;
 private heartbeatTimer:ReturnType<typeof setTimeout>|null=null;
 private lastPosition:string|null=null;
 private closed=false;
 private resetting=false;
 private seenReady=false;
 private halting=false;
 private paused=false;
 private programPaused=false;
 private restorePower:string|null=null;
 constructor(private stream:GcodeStream,private timeoutMs:number,private window=127,private armingTimeoutMs=timeoutMs,private dialect:"grbl"|"smoothieware"|"marlin"|"snapmaker"="grbl"){
  super();
  stream.on("data",(data:Uint8Array)=>this.receive(data));
  stream.on("error",(error:Error)=>this.fail(error));
  stream.on("close",()=>{this.closed=true;this.fail(new Error("The controller disconnected. Check the piece before preparing another job."));});
 }
 private receive(data:Uint8Array):void{
  this.input+=new TextDecoder().decode(data);
  if(this.input.length>65536){this.fail(new Error("The controller reply exceeds the protocol limit."));this.stream.destroy();return;}
  let end:number;
  while((end=this.input.indexOf("\n"))>=0){const line=this.input.slice(0,end).trim();this.input=this.input.slice(end+1);if(line)this.line(line);}
 }
 private line(line:string):void{
  if(/^Grbl|^FluidNC/i.test(line)||/^start$|^echo:Marlin|^Smoothie Running /i.test(line)){
   const expected=this.resetting||!this.seenReady;this.resetting=false;
   if(!expected)this.fail(new Error("The controller restarted. Prepare a fresh job after checking its position."));
   this.emit("reset",line);return;
  }
  if(line.startsWith("<")){
   this.seenReady=true;
   const paused=/^<(?:Hold|Door)/i.test(line);
   if(paused!==this.paused){this.paused=paused;this.armDeadline();}
   const position=/(?:[|,]|^)(MPos|WPos):([^|>]*?)(?=[|>]|,[A-Za-z]+:)/.exec(line);
   if(position&&position[2]!.split(",").length>=2&&position[2]!.split(",").every(v=>v.trim()!==""&&Number.isFinite(Number(v)))){
    const key=position[1]+":"+position[2]!.split(",").map(Number).join(",");
    if(this.program&&/^<Run(?:[:,|>])/i.test(line)&&this.lastPosition!==null&&key!==this.lastPosition&&key.startsWith(this.lastPosition.split(":")[0]+":"))this.armDeadline();
    this.lastPosition=key;
   }
   this.emit("status",line);return;
  }
  if(this.halting&&/^ALARM:/.test(line)){this.halting=false;this.emit("halt",line);return;}
  if(/^error:|^ALARM:|^Error:|^!!|(?:^|echo:)\s*unknown command|^Command not found:/i.test(line)){
   const running=!!this.program;this.fail(new Error(`The controller refused the job (${line.slice(0,160)}). Check the piece before preparing another job.`));
   if(running)this.halt();return;
  }
  if(/^ok(?:\s|$)/i.test(line)){
   this.seenReady=true;const p=this.pending.shift();if(!p)return;
   this.used-=p.bytes;p.resolve(p.reply.join("\n"));
   if(this.program&&p.program){this.program.acked++;this.emit("progress",this.program.acked/this.program.lines.length);this.pump();}
   this.armDeadline();if(!this.pending.length)this.emit("drain","");return;
  }
  const pending=this.pending[0];
  if(pending){
   pending.replyBytes+=byteLength(line)+1;
   if(pending.replyBytes>65536){this.fail(new Error("The controller reply exceeds the protocol limit."));this.stream.destroy();return;}
   pending.reply.push(line);
  }
 }
 private armDeadline():void{
  if(this.deadline)clearTimeout(this.deadline);
  this.deadline=null;
  if(this.pending.length&&!this.paused)this.deadline=setTimeout(()=>{
   const running=!!this.program;this.fail(new Error("The controller stopped acknowledging commands. Check the piece before preparing another job."));
   if(running)this.halt();
  },this.pending[0]!.timeoutMs);
 }
 private send(line:string,resolve:(reply:string)=>void,reject:(error:Error)=>void,commandTimeoutMs=this.timeoutMs,program=false):void{
  const consoleCommand=this.dialect==="smoothieware"&&(/^(?:config-get \S+|fire off)$/.test(line));
  const wire=line+"\n"+(consoleCommand?"M400\n":"");
  const bytes=byteLength(wire);
  const timeoutMs=this.program&&/^M[34] S0$/.test(line)?this.armingTimeoutMs:commandTimeoutMs;
  this.pending.push({program,bytes,reply:[],replyBytes:0,timeoutMs,resolve,reject});this.used+=bytes;this.armDeadline();
  this.stream.write(wire,error=>{if(error)this.fail(error);});
 }
 command(line:string,timeoutMs=this.timeoutMs):Promise<string>{
  if(this.closed)return Promise.reject(new Error("The laser controller is disconnected."));
  if((this.program&&!this.programPaused)||this.pending.length)return Promise.reject(new Error("The controller is already processing a command."));
  if(/[\r\n]/.test(line)||byteLength(line)+1>this.window)return Promise.reject(new Error("This controller command exceeds its receive buffer."));
  return new Promise((resolve,reject)=>this.send(line,resolve,reject,timeoutMs));
 }
 run(code:string):Promise<void>{
  if(this.closed||this.program||this.pending.length)return Promise.reject(new Error("The controller is unavailable or already running."));
  const lines=code.split("\n").map(l=>l.trim()).filter(Boolean);
  if(!lines.length||lines.some(l=>byteLength(l)+1>this.window))return Promise.reject(new Error("The laser program exceeds the controller's receive buffer."));
  return new Promise((resolve,reject)=>{this.lastPosition=null;this.program={lines,next:0,acked:0,resolve,reject};this.pump();this.heartbeat();});
 }
 private pump():void{
  const p=this.program;if(!p||this.programPaused)return;
  while(p.next<p.lines.length){if((this.dialect==="marlin"||this.dialect==="snapmaker"||this.dialect==="smoothieware")&&this.pending.length)break;const line=p.lines[p.next]!;if(this.used+byteLength(line)+1>this.window)break;p.next++;if(/^M[34]/.test(line))this.restorePower=this.dialect==="marlin"?"M3 I S0":line;else if(/^M5/.test(line))this.restorePower=null;this.send(line,()=>{},()=>{},this.timeoutMs,true);}
  if(p.acked===p.lines.length){this.program=null;this.clearHeartbeat();p.resolve();}
 }
 private heartbeat():void{
  if(!this.program||this.heartbeatTimer||this.dialect==="marlin"||this.dialect==="snapmaker")return;
  this.heartbeatTimer=setTimeout(()=>{
   this.heartbeatTimer=null;if(!this.program||this.closed)return;
   this.stream.write("?",error=>{if(error)this.fail(error);});this.heartbeat();
  },Math.min(1000,this.timeoutMs/4));
 }
 private clearHeartbeat():void{if(this.heartbeatTimer)clearTimeout(this.heartbeatTimer);this.heartbeatTimer=null;this.lastPosition=null;}
 private fail(error:Error):void{
  this.clearHeartbeat();
  if(this.deadline)clearTimeout(this.deadline);this.deadline=null;
  const pending=this.pending;this.pending=[];this.used=0;
  const program=this.program;this.program=null;this.programPaused=false;this.restorePower=null;
  for(const p of pending)p.reject(error);program?.reject(error);this.emit("fault",error);
 }
 private halt():void{
  if(this.dialect==="marlin"||this.dialect==="snapmaker"){this.closed=true;this.stream.write("M112\n");}
  else if(this.dialect==="smoothieware"){this.closed=true;this.stream.write(Uint8Array.from([24]));}
  else{this.resetting=true;this.stream.write(Uint8Array.from([24]));this.stream.write("M5\n");}
 }
 async pause():Promise<void>{
  if(this.dialect!=="marlin"&&this.dialect!=="snapmaker"&&this.dialect!=="smoothieware"){this.realtime(33);return;}
  if(!this.program||this.programPaused)throw new Error("The laser has no running job to pause.");
  this.programPaused=true;
  if(this.pending.length)await this.wait("drain",this.timeoutMs);
  if(!this.program)throw new Error("The laser was stopped while pausing.");
  if(this.dialect==="smoothieware"){await this.command("M400");await this.command("fire off");}
  else await this.command(this.dialect==="marlin"?"M5 I":"M5");
 }
 async resume():Promise<void>{
  if(this.dialect!=="marlin"&&this.dialect!=="snapmaker"&&this.dialect!=="smoothieware"){this.realtime(126);return;}
  if(!this.program||!this.programPaused)throw new Error("The laser has no paused job to resume.");
  if(this.restorePower&&this.dialect!=="smoothieware")await this.command(this.restorePower);
  if(!this.program)throw new Error("The laser was stopped while resuming.");
  this.programPaused=false;this.pump();
 }
 async status():Promise<string>{
  if(this.closed)throw new Error("The controller is disconnected.");
  if(this.dialect==="marlin"||this.dialect==="snapmaker"){
   if(this.program)return `<${this.programPaused?"Hold":"Run"}>`;
   if(this.dialect==="snapmaker"){
    const report=await this.command("M2000 S0");
    const state=/^systat:\s*(\d+)\s*$/m.exec(report)?.[1];
    if(state!=="1")throw new Error("Snapmaker must report idle before station setup or a new job.");
    if(!/^Fault:\s*0x0+, action ban:\s*0x0+, power ban:\s*0x0+\s*$/m.test(report))throw new Error("Check Snapmaker's reported faults at its screen before continuing.");
    await this.command("M400");const position=await this.command("M114");
    if(!/X:\s*-?[0-9.]+\s+Y:\s*-?[0-9.]+/.test(position))throw new Error("Snapmaker did not report its position.");
    return "<Idle>";
   }
   const identity=await this.command("M115");
   if(!/^Cap:SDCARD:0$/m.test(identity)){
    const sd=await this.command("M27");if(/SD printing byte/i.test(sd))return "<Run>";
    if(!/Not SD printing/i.test(sd))throw new Error("The controller did not confirm that its stored job is stopped.");
   }
   await this.command("M400");const position=await this.command("M114");
   if(!/X:\s*-?[0-9.]+\s+Y:\s*-?[0-9.]+/.test(position))throw new Error("The controller did not report its position.");
   return "<Idle>";
  }
  const reply=this.wait("status",this.timeoutMs);
  this.stream.write("?");return reply;
 }
 realtime(byte:number):void{if(byte===33||byte===126){this.paused=byte===33;this.armDeadline();}if(this.closed)throw new Error("The controller is disconnected.");this.stream.write(Uint8Array.from([byte]));}
 private wait(event:"status"|"reset"|"halt"|"drain",timeout:number):Promise<string>{
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);this.off(event,accept);this.off("fault",refuse);};
   const accept=(line:string)=>{cleanup();resolve(line);};const refuse=(error:Error)=>{cleanup();reject(error);};
   const timer=setTimeout(()=>{cleanup();reject(new Error("The controller did not confirm its state."));},timeout);
   this.once(event,accept);this.once("fault",refuse);
  });
 }
 async stop():Promise<void>{
  if(this.closed)throw new Error("The controller connection is closed.");
  this.fail(new Error("The laser was stopped. Prepare a fresh review before Start."));this.input="";this.paused=false;
  if(this.dialect==="marlin"||this.dialect==="snapmaker"){
   this.closed=true;await new Promise<void>((resolve,reject)=>this.stream.write("M112\n",error=>error?reject(error):resolve()));return;
  }
  if(this.dialect==="smoothieware"){
   this.halting=true;const halt=this.wait("halt",this.timeoutMs);this.realtime(24);
   try{await halt;}finally{this.closed=true;this.halting=false;}return;
  }
  this.resetting=true;
  const reset=this.wait("reset",this.timeoutMs);this.realtime(24);
  await reset;await this.command("M5");
 }
 async close():Promise<void>{this.closed=true;this.fail(new Error("The controller connection was closed."));this.stream.destroy();}
}
