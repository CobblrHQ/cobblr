import type {LaserController} from "@cobblr/digifab/laser-controller";
import {routeBrowserLaser,type BrowserLaserRequest} from "./browser-laser-wire";
export interface BrowserLaserTunnel {relay:string;token:string;bridge:string;instance:string;signal:AbortSignal;driver:LaserController;onError?:(message:string)=>void}
const pause=(signal:AbortSignal,ms:number)=>new Promise<void>(resolve=>{
 if(signal.aborted){resolve();return;}
 const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",finish);resolve();};
 const timer=setTimeout(finish,ms);signal.addEventListener("abort",finish,{once:true});
});
export async function registerBrowserLaser(options:BrowserLaserTunnel):Promise<void>{
 const result=await fetch(`${options.relay}/register?bridge=${encodeURIComponent(options.bridge)}`,{method:"POST",headers:{authorization:`Bearer ${options.token}`,"content-type":"application/json"},body:JSON.stringify({kind:"device",channel:"device",hostname:"Browser serial station",instances:[options.instance],features:["abort","lanes","blobs","browser-serial"]}),signal:AbortSignal.any([options.signal,AbortSignal.timeout(15_000)])});
 if(!result.ok)throw new Error("This browser could not connect its selected machine to the workspace.");
}
export async function runBrowserLaserTunnel(options:BrowserLaserTunnel):Promise<void>{
 const ending=new AbortController();
 const lifetime=AbortSignal.any([options.signal,ending.signal]);
 const auth={authorization:`Bearer ${options.token}`},q=`?bridge=${encodeURIComponent(options.bridge)}`;
 const pending=new Set<Promise<void>>();let devices=0,controls=0,backoff=1000;
 const request=(item:BrowserLaserRequest)=>{
  const control=item.lane==="control";if(control)controls++;else devices++;
  const timeout=Math.max(1000,Math.min(Number(item.timeoutMs)||20_000,310_000));
  const signal=AbortSignal.any([lifetime,AbortSignal.timeout(timeout)]);
  const task=(async()=>{
   try{
    const work=routeBrowserLaser(options.driver,options.instance,item,options.relay,options.token,signal,options.bridge);
    const result=await Promise.race([work,new Promise<{status:number;body:unknown}>(resolve=>{
     const expired=()=>resolve({status:504,body:{error:"The browser station could not confirm this operation before its deadline. Check the machine."}});
     if(signal.aborted)expired();else signal.addEventListener("abort",expired,{once:true});
    })]);
    if(lifetime.aborted)return;
    const response=await fetch(`${options.relay}/respond${q}`,{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({id:item.id,...result}),signal:AbortSignal.any([lifetime,AbortSignal.timeout(15_000)])});
    if(!response.ok)throw new Error("The browser station response was refused.");
   }catch{if(!lifetime.aborted)options.onError?.("The browser station lost a controller response. Check the machine before continuing.");}
   finally{if(control)controls--;else devices--;}
  })();
  pending.add(task);void task.finally(()=>pending.delete(task));
 };
 try{
  while(!lifetime.aborted){
   const lanes=[...(devices<6?["device"]:[]),...(controls<2?["control"]:[])];
   if(!lanes.length){await pause(lifetime,50);continue;}
   try{
    const response=await fetch(`${options.relay}/poll${q}&lanes=${lanes.join(",")}`,{headers:auth,signal:AbortSignal.any([lifetime,AbortSignal.timeout(90_000)])});
    if(response.status===401||response.status===403)throw new BrowserLaserRevoked();
    if(response.status===204){backoff=1000;continue;}
    if(!response.ok){await pause(lifetime,backoff);backoff=Math.min(backoff*2,30_000);continue;}
    const item=await response.json() as BrowserLaserRequest;backoff=1000;request(item);
   }catch(error){
    if(lifetime.aborted)break;
    if(error instanceof BrowserLaserRevoked)throw new Error("This browser station's device permission was revoked. Connect it again at the machine.");
    await pause(lifetime,backoff);backoff=Math.min(backoff*2,30_000);
   }
  }
 }finally{ending.abort();await options.driver.close();await Promise.allSettled(pending);}
}
class BrowserLaserRevoked extends Error{}
