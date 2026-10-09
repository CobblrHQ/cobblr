import {createContext,useEffect,useRef,useState,type ReactNode} from "react";
import type {SerialPortLike} from "@cobblr/platform-web";
import type {LaserController} from "@cobblr/digifab/laser-controller";
import {useActiveOrg} from "../../auth/ActiveOrgContext";
import {api} from "../../lib/api";
import {keepStationScreenAwake} from "../../lib/screen-awake";
export interface BrowserMachine {slug:string;bridge:string;instance:string;connectionId:string}
export interface BrowserSession {machine:BrowserMachine;controller:AbortController;driver:LaserController;done:Promise<void>}
interface BrowserLaserState {machine:BrowserMachine|null;busy:boolean;error:string;connect:()=>Promise<void>;disconnect:()=>Promise<void>}
export const BrowserLaserContext=createContext<BrowserLaserState|null>(null);
export function BrowserLaserProvider({children}:{children:ReactNode}){
 const {activeSlug:slug}=useActiveOrg();
 const [machine,setMachine]=useState<BrowserMachine|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const active=useRef<BrowserSession|null>(null),generation=useRef(0);
 const disconnect=async()=>{
  generation.current++;const session=active.current;active.current=null;setMachine(null);
  if(!session)return;
  session.controller.abort();await session.driver.close();await session.done;
  await api.disconnectEdgeBridge(session.machine.slug,session.machine.bridge).catch(()=>{});
 };
 useEffect(()=>()=>{void disconnect();},[slug]);
 useEffect(()=>machine?keepStationScreenAwake(document,navigator.wakeLock):undefined,[machine]);
 useEffect(()=>{if(!machine)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[machine]);
 const connect=async()=>{
  if(busy||active.current)return;setBusy(true);setError("");
  const version=++generation.current;
  const stillConnecting=()=>{if(version!==generation.current)throw new Error("The workspace changed while connecting this machine.");};
  try{
   const serial=(navigator as Navigator&{serial?:{requestPort:()=>Promise<SerialPortLike>}}).serial;
   if(!serial)throw new Error("Use Chrome or Edge on a laptop or Chromebook. Chrome on Android does not support USB Web Serial.");
   const port=await serial.requestPort();stillConnecting();
   const {connectBrowserLaser}=await import("../../lib/browser-laser-connection");
   stillConnecting();
   await connectBrowserLaser({port,slug,active,stillConnecting,setMachine,setError});
  }catch(failure){
   setError(failure instanceof Error?failure.message:"The browser serial machine could not connect.");
  }finally{setBusy(false);}
 };
 return <BrowserLaserContext.Provider value={{machine,busy,error,connect,disconnect}}>{children}</BrowserLaserContext.Provider>;
}
