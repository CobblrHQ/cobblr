import {useEffect,useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {promptInstall,readInstallEnv,resetInstallPrompt} from "../../lib/install-app";
export function StationInstall(){
 const path=window.location.pathname;
 const [instruction,setInstruction]=useState("");
 const installed=readInstallEnv().standalone;
 useEffect(()=>{
  const existing=document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const link=existing||document.createElement("link");const previous=link.getAttribute("href");
  link.rel="manifest";link.href=`/api/v1/desktop/station.webmanifest?start=${encodeURIComponent(path)}`;
  if(!existing)document.head.append(link);
  resetInstallPrompt();
  return()=>{resetInstallPrompt();if(!existing)link.remove();else if(previous!==null)link.setAttribute("href",previous);else link.removeAttribute("href");};
 },[path]);
 const install=useMutation({mutationFn:promptInstall,onSuccess:result=>{
  if(result!=="unavailable")return;
  const env=readInstallEnv();const ios=/iPhone|iPad|iPod/.test(env.userAgent)||(env.platform==="MacIntel"&&env.maxTouchPoints>1);
  setInstruction(ios?"Use Share, then Add to Home Screen. The shortcut opens this machine station.":"Open your browser menu and choose Install app or Add to Home Screen. The shortcut opens this machine station.");
 },onError:()=>setInstruction("Open your browser menu and install this station from there.")});
 if(installed)return null;
 return <section className="rounded border border-line p-4 space-y-2"><button type="button" className="min-h-12 rounded border border-line px-4 py-3" disabled={install.isPending} onClick={()=>install.mutate()}>Install this machine station</button><p>This shortcut opens this machine. The screen stays awake during a job when your browser allows it.</p>{instruction&&<p role="status">{instruction}</p>}</section>;
}
