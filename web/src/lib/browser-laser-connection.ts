import type {SerialPortLike} from "@cobblr/platform-web";
import {LaserController} from "@cobblr/digifab/laser-controller";
import type {BrowserMachine,BrowserSession} from "../features/digifab/BrowserLaser";
import {api} from "./api";
import {openBrowserLaserPort} from "./browser-laser-port";
import {browserLaserHash} from "./browser-laser-wire";
import {registerBrowserLaser,runBrowserLaserTunnel} from "./browser-laser-tunnel";
import { randomId } from "@cobblr/platform-contract/random-id";
interface ConnectionOptions {
 port:SerialPortLike;slug:string;active:{current:BrowserSession|null};stillConnecting:()=>void;
 setMachine:(machine:BrowserMachine|null)=>void;setError:(error:string)=>void;
}
export async function connectBrowserLaser({port,slug,active,stillConnecting,setMachine,setError}:ConnectionOptions):Promise<void>{
 let driver:LaserController|null=null,paired:string|null=null;
 const controller=new AbortController();
 try{
   driver=new LaserController({firmware:"grbl",name:"Browser USB laser",timeoutMs:5000},{open:()=>openBrowserLaserPort(port),hash:browserLaserHash,uuid:()=>randomId()});
   const setup=await driver.getLaserSetup();
   if(!setup.laserMode)throw new Error("Set GRBL laser mode ($32=1) on this controller before connecting it as a laser.");
   stillConnecting();
   const bridge=`browser-${randomId().slice(0,12)}`,instance=`serial-${randomId().slice(0,12)}`;
   const code=await api.createEdgePairingCode(slug,"Browser USB laser",bridge);stillConnecting();
   const response=await fetch("/api/v1/edge/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:code.code}),signal:AbortSignal.timeout(15_000)});
   const pairing=await response.json() as {relay_path?:string;token?:string;bridge?:string};
   if(!response.ok||!pairing.token||pairing.bridge!==bridge||pairing.relay_path!==`/api/v1/orgs/${slug}/edge`)throw new Error("The browser station could not join this workspace.");
   paired=bridge;stillConnecting();
   const relay=window.location.origin+pairing.relay_path;
   const options={relay,token:pairing.token,bridge,instance,driver,signal:controller.signal,onError:setError};
   await registerBrowserLaser(options);stillConnecting();
   let finished:Promise<void>=Promise.resolve();
   const session:BrowserSession={machine:{slug,bridge,instance,connectionId:""},controller,driver,done:finished};
   active.current=session;
   finished=runBrowserLaserTunnel(options).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:"The browser controller disconnected.");}).finally(()=>{if(active.current===session){active.current=null;setMachine(null);}});
   session.done=finished;
   const connection=await api.createDigifabConnection(slug,{type:"edge_adapter",label:"Browser USB laser",base_url:`cobblr-edge://${instance}`,config:{driver:"gcode-laser",firmware:"grbl",transport:"serial",path:"web-serial",bridge,name:"Browser USB laser"}});
   stillConnecting();
   if(active.current!==session||controller.signal.aborted)throw new Error("The browser controller disconnected while its station was being created.");
   session.machine.connectionId=connection.id;setMachine({...session.machine});
 }catch(failure){
   controller.abort();await driver?.close().catch(()=>{});
   if(active.current?.controller===controller){await active.current.done;active.current=null;setMachine(null);}
   if(paired)await api.disconnectEdgeBridge(slug,paired).catch(()=>{});
   throw failure;
 }
}
