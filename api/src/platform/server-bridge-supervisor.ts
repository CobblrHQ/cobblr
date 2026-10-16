import { productName } from "./product-name.js";
import {createHash} from "node:crypto";
import {readdir,readFile,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {ServerBridgeConfig,type WorkspaceBridgeConfig} from "@cobblr/platform-contract/server-bridge";
import {bridgeBundleJs} from "./edge-bridge-bundle.js";

export interface ServerBridgeWorker {
 update:(configs:WorkspaceBridgeConfig[])=>Promise<void>;
 stop:()=>Promise<void>;
 isAlive:()=>boolean;
}
export class ServerBridgeSupervisor{
 private worker:ServerBridgeWorker|undefined;
 private fingerprint="";
 private stopped=false;
 constructor(private options:{directory:string;cache:string;launch:(cache:string)=>Promise<ServerBridgeWorker>}){}
 async reconcile():Promise<void>{
  if(this.stopped)return;
  let files:string[];
  try{files=await readdir(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")files=[];else throw error;}
  const configs:WorkspaceBridgeConfig[]=[];
  for(const file of files.sort()){
   if(!/^[0-9a-f-]{36}\.json$/.test(file))continue;
   try{
    const raw=await readFile(join(this.options.directory,file));if(raw.length>8192)continue;
    const config=ServerBridgeConfig.parse(JSON.parse(raw.toString("utf8")));if(file===`${config.orgId}.json`)configs.push(config);
   }catch{console.error("[server-bridge] a workspace configuration could not load");}
  }
  const fingerprint=createHash("sha256").update(JSON.stringify(configs)).digest("hex");
  if(!this.worker?.isAlive()){
   await this.worker?.stop();this.worker=await this.options.launch(this.options.cache);this.fingerprint="";
  }
  if(this.stopped){await this.worker.stop();return;}
  if(this.fingerprint!==fingerprint){await this.worker.update(configs);this.fingerprint=fingerprint;}
 }
 async stop():Promise<void>{this.stopped=true;await this.worker?.stop();this.worker=undefined;}
}
export async function launchServerBridge(cache:string):Promise<ServerBridgeWorker>{
 await mkdir(cache,{recursive:true,mode:0o700});const bundle=join(cache,"bridge.bundle.cjs");await writeFile(bundle,bridgeBundleJs(),{mode:0o600});
 const env:NodeJS.ProcessEnv={BRIDGE_SERVER_MODE:"true",BRIDGE_NETWORK_ONLY:"true",BRIDGE_HOST_NAME:`${productName()} Server`};
 for(const key of ["PATH","TMPDIR","TEMP","SystemRoot","SSL_CERT_FILE","NODE_EXTRA_CA_CERTS"])if(process.env[key])env[key]=process.env[key];
 const child=spawn(process.execPath,[bundle],{cwd:cache,env,stdio:["ignore","inherit","inherit","ipc"]});
 let alive=true;child.once("error",()=>{alive=false;});child.once("exit",()=>{alive=false;});
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("The server bridge did not become ready.")),30_000);
  const ready=(message:unknown)=>{if((message as {type?:unknown}|null)?.type==="server-bridge-ready"){clearTimeout(timer);child.off("message",ready);resolve();}};
  child.on("message",ready);child.once("error",()=>{clearTimeout(timer);reject(new Error("The server bridge could not start."));});child.once("exit",()=>{clearTimeout(timer);reject(new Error("The server bridge stopped before it became ready."));});
 }).catch(error=>{child.kill("SIGTERM");throw error;});
 return {isAlive:()=>alive,update:configs=>new Promise<void>((resolve,reject)=>{
  child.send({type:"server-bridge-workspaces",configs},error=>{if(error)reject(new Error("The server bridge workspace update failed."));else resolve();});
 }),stop:async()=>{
  if(!alive)return;
  await new Promise<void>(resolve=>{
   const timer=setTimeout(()=>{if(alive)child.kill("SIGKILL");},30_000);
   const finish=()=>{clearTimeout(timer);resolve();};child.once("exit",finish);child.once("error",finish);child.kill("SIGTERM");
  });
 }};
}
