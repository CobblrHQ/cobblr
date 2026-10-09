import {z} from "zod";
import type {LaserController} from "@cobblr/digifab/laser-controller";
import {LaserCommissionSchema} from "@cobblr/platform-contract/laser-setup";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
export const browserLaserHash=(value:string|Uint8Array)=>bytesToHex(sha256(typeof value==="string"?new TextEncoder().encode(value):value));
const RelayRequest=z.object({id:z.string().max(200),path:z.string().max(1000),method:z.string().optional(),body:z.unknown().optional(),timeoutMs:z.number().optional(),lane:z.string().optional(),instance:z.object({id:z.string(),driver:z.string(),config:z.record(z.unknown()).optional()}).optional(),source:z.unknown().optional(),blob:z.object({id:z.string().regex(/^[a-f0-9-]{8,64}$/i),direction:z.enum(["down","up"]),sha256:z.string().regex(/^[a-f0-9]{64}$/i).optional(),size:z.number().nonnegative().optional()}).optional()});
export type BrowserLaserRequest=z.infer<typeof RelayRequest>;
export interface BrowserLaserResponse {status:number;body:unknown}
const Submit=z.object({fileId:z.string(),target:z.string().nullable().optional(),approval:z.object({projectHash:z.string()}).optional()});
const Control=z.object({id:z.string(),params:z.record(z.unknown()).optional()});
const File=z.object({filename:z.string().max(200).optional(),data_b64:z.string().max(28*1024*1024)});
const MAX_BYTES=20*1024*1024;
async function fileBytes(item:BrowserLaserRequest,relay:string,token:string,signal:AbortSignal,bridge?:string):Promise<Uint8Array>{
 if(item.blob){
  if(item.blob.direction!=="down"||!item.blob.sha256||item.blob.size===undefined||item.blob.size>MAX_BYTES)throw new Error("This browser station needs a checked laser plan smaller than 20 MB.");
  if(!bridge)throw new Error("This laser plan needs its selected bridge channel.");
  const response=await fetch(`${relay}/blobs/${item.blob.id}?bridge=${encodeURIComponent(bridge)}`,{headers:{authorization:`Bearer ${token}`},signal});
  if(!response.ok||!response.body)throw new Error("The laser plan could not be downloaded.");
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{
   while(true){const result=await reader.read();if(result.done)break;size+=result.value.length;if(size>MAX_BYTES)throw new Error("The laser plan is over 20 MB.");parts.push(result.value);}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  if(size!==item.blob.size||browserLaserHash(bytes)!==item.blob.sha256.toLowerCase())throw new Error("The laser plan arrived different from the reviewed file. Nothing was prepared.");
  return bytes;
 }
 const body=File.parse(item.body),decoded=atob(body.data_b64);
 if(decoded.length>MAX_BYTES)throw new Error("The laser plan is over 20 MB.");
 return Uint8Array.from(decoded,character=>character.charCodeAt(0));
}
export async function routeBrowserLaser(driver:LaserController,instance:string,raw:unknown,relay:string,token:string,signal:AbortSignal,bridge?:string):Promise<BrowserLaserResponse>{
 try{
  const item=RelayRequest.parse(raw);
  if(item.path==="/discover"&&!item.instance&&!item.source)return {status:200,body:{items:[],warnings:["This browser station serves its selected USB laser. Connect another machine through a nearby bridge."]}};
  if(item.source||item.instance&&(item.instance.id!==instance||item.instance.driver!=="gcode-laser"||item.instance.config?.firmware!=="grbl"))return {status:403,body:{error:"This browser station serves only its selected GRBL machine."}};
  const prefix=`/${instance}/`;if(!item.path.startsWith(prefix))return {status:404,body:{error:"This browser station serves a different machine."}};
  const path=item.path.slice(prefix.length-1),method=(item.method||"GET").toUpperCase();
  if(method==="GET"){
   if(path==="/devices")return {status:200,body:await driver.listDevices()};
   if(path==="/capabilities")return {status:200,body:{jobReview:true,jobReviewKind:"laser",laserSetup:true,laserBackend:"gcode"}};
   if(path==="/laser/setup")return {status:200,body:await driver.getLaserSetup()};
   if(path==="/controls")return {status:200,body:driver.listControls()};
   if(path==="/files")return {status:200,body:[]};
   if(path.startsWith("/status/"))return {status:200,body:await driver.getJobStatus(decodeURIComponent(path.slice(8)))};
   if(path.startsWith("/review/"))return {status:200,body:await driver.getJobReview(decodeURIComponent(path.slice(8)))};
  }
  if(method==="POST"){
   if(path==="/laser/home")return {status:200,body:await driver.homeLaser()};
   if(path==="/laser/commission")return {status:200,body:await driver.commissionLaser(LaserCommissionSchema.parse(item.body))};
   if(path==="/control"){const body=Control.parse(item.body);return {status:200,body:await driver.runControl(body.id,body.params||{})};}
   if(path==="/prepare"){const bytes=await fileBytes(item,relay,token,signal,bridge);if(signal.aborted)throw new Error("This browser station was disconnected.");return {status:200,body:await driver.prepareJob(bytes,"laser-plan.json")};}
   if(path==="/submit"){const body=Submit.parse(item.body);return {status:200,body:await driver.submitJob(body.fileId,body.target||null,body.approval)};}
   if(path==="/upload")return {status:409,body:{error:"Review and approve this laser job at its authorized station before Start."}};
  }
  return {status:501,body:{error:"This operation is not available on a browser serial laser."}};
 }catch(error){return {status:502,body:{error:error instanceof Error?error.message:"The browser serial controller could not answer."}};}
}
