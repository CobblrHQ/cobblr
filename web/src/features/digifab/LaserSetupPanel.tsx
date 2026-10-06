import {GalvoSetupFields,type GalvoSetupMemory} from "./GalvoSetupFields";
import { useRef,useState,type MutableRefObject } from "react";
import {useMutation} from "@tanstack/react-query";
import type { LaserSetup } from "@cobblr/platform-contract/laser-setup";
import { api } from "../../lib/api";
const button="min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
export function LaserSetupPanel({slug,connectionId,deviceId,blocked,stationToken,galvoMemory}:{galvoMemory?:MutableRefObject<GalvoSetupMemory>;slug:string;connectionId:string;deviceId:string;blocked:boolean;stationToken?:string}){
 const [galvoReset,setGalvoReset]=useState(0);
 const [report,setReport]=useState<LaserSetup|null>(null),[error,setError]=useState("");
 const [restartConfirmed,setRestartConfirmed]=useState(false);
 const [ruidaX,setRuidaX]=useState<""|"forward"|"reverse">(""),[ruidaY,setRuidaY]=useState<""|"forward"|"reverse">("");
 const [axesConfirmed,setAxesConfirmed]=useState(false),[firstTubeConfirmed,setFirstTubeConfirmed]=useState(false);
 const [powerUnit,setPowerUnit]=useState<""|"PWM"|"PERCENT">("");
 const [powerUnitConfirmed,setPowerUnitConfirmed]=useState(false),[inlineConfirmed,setInlineConfirmed]=useState(false),[coolantConfirmed,setCoolantConfirmed]=useState(false);
 const request=useMutation({mutationKey:["laser-setup",slug,connectionId,deviceId],mutationFn:(run:()=>Promise<LaserSetup>)=>run()});
 const busy=request.isPending,working=useRef(false);
 const read=async(home=false)=>{
  if(working.current||blocked||(home&&!stationToken))return;
  working.current=true;setGalvoReset(value=>value+1);setError("");setReport(null);setRestartConfirmed(false);setPowerUnit("");setPowerUnitConfirmed(false);setInlineConfirmed(false);setCoolantConfirmed(false);setRuidaX("");setRuidaY("");setAxesConfirmed(false);setFirstTubeConfirmed(false);
  try{setReport(await request.mutateAsync(()=>home?api.setLaserSetup(slug,{connection_id:connectionId,device_id:deviceId,operation:"home",station_token:stationToken}):api.getLaserSetup(slug,connectionId,deviceId)));}
  catch(e){setError(e instanceof Error?e.message:"The laser did not confirm its setup.");}
  finally{working.current=false;}
 };
 const sendCommission=async(configuration:import("@cobblr/platform-contract/laser-setup").LaserCommission)=>{
  if(working.current||blocked||!stationToken||!report)return;
  working.current=true;setError("");
  try{setReport(await request.mutateAsync(()=>api.setLaserSetup(slug,{connection_id:connectionId,device_id:deviceId,operation:"commission",station_token:stationToken,configuration})));}
  catch(e){setReport(null);setError(e instanceof Error?e.message:"The firmware setup could not be confirmed.");}
  finally{setRestartConfirmed(false);setGalvoReset(value=>value+1);working.current=false;}
 };
 const commission=async()=>{
  if(working.current||blocked||!stationToken||!report)return;
  const binding={sessionId:report.sessionId,identityHash:report.identityHash,settingsHash:report.settingsHash};
  let configuration:import("@cobblr/platform-contract/laser-setup").LaserCommission;
  if(report.firmware==="forgefirm"&&restartConfirmed)configuration={...binding,firmware:"forgefirm",restartConfirmed:true};
  else if(report.firmware==="smoothieware"&&restartConfirmed)configuration={...binding,firmware:"smoothieware",restartConfirmed:true,coolantConfirmed};
  else if(report.firmware==="marlin"&&report.canHome&&report.laserMode&&powerUnit&&powerUnitConfirmed&&inlineConfirmed)configuration={...binding,firmware:"marlin",powerUnit,powerUnitConfirmed:true,inlinePowerConfirmed:true,coolantConfirmed};
  else if(report.firmware==="ruida"&&ruidaX&&ruidaY&&axesConfirmed&&firstTubeConfirmed)configuration={...binding,firmware:"ruida",flipX:ruidaX==="reverse",flipY:ruidaY==="reverse",axesConfirmed:true,firstTubeConfirmed:true};
  else return;
  await sendCommission(configuration);
 };
 return <section className="rounded border border-line p-4 space-y-3" aria-label="Laser setup">
  <h2 className="text-xl font-semibold font-mono uppercase tracking-wide">Laser setup</h2>
  <p>{report?.firmware==="galvo"?"Check the lens field and set focus at the machine. A galvo has no mechanical Home.":"Check the controller before loading a job. Home moves the head to its reference position. Clear the bed and check the machine first."}</p>
  <div className="flex flex-wrap gap-3"><button className={button} disabled={busy||blocked} onClick={()=>void read()}>Check laser setup</button>{report?.firmware!=="galvo"&&<button className={button} disabled={busy||blocked||!stationToken||!report?.canHome} onClick={()=>void read(true)}>Home laser</button>}</div>
  {busy&&<p role="status">Waiting for the controller. Stop remains available.</p>}
  {error&&<p role="alert" className="text-red-600 dark:text-red-400 break-words">{error}</p>}
  {report&&<div className="space-y-2"><p>Power scale: {report.powerMin??"unknown"} to {report.powerMax??"unknown"}.</p><p>{report.firmware==="galvo"?(report.commissioned?"Source settings are confirmed for this USB connection.":"Confirm the lens and source before marking is allowed."):report.laserMode?"Laser mode is enabled.":"Enable laser mode at the controller before Frame or Start."}</p><p>{report.firmware==="galvo"?(report.commissioned?"Lens field confirmed for this connection. Use the red guide to check placement.":"Confirm the lens field and source before Frame or Start."):report.homed?"Position checked for this connection. Frame and Start check it again.":report.needsHoming?"Home is required before Frame or Start.":"The controller has no enabled homing switches. Check the origin at the machine."}</p>{report.facts.map((fact,index)=><p key={index} className="text-sm text-muted break-words">{fact}</p>)}</div>}
  <GalvoSetupFields memory={galvoMemory} report={report} disabled={busy||blocked||!stationToken} reset={galvoReset} onConfirm={configuration=>void sendCommission(configuration)} />
  {report?.firmware==="ruida"&&report.needsCommissioning&&!report.commissioned&&<div className="space-y-3">
   <p>Ruida uses machine coordinates. Check the coordinates on its panel against the sheet's lower left corner. This driver uses laser tube 1 and keeps tube 2 off. Focus is set at the machine.</p>
   {report.bed&&<p>Controller bed: {report.bed.width} × {report.bed.height} mm. Match the saved machine bed to these dimensions.</p>}
   <label className="block">Ruida X direction<select className="block min-h-12 w-full rounded border border-line bg-surface p-2" value={ruidaX} onChange={e=>setRuidaX(e.target.value as typeof ruidaX)} disabled={busy||blocked||!stationToken}><option value="">Check the panel coordinates</option><option value="forward">X increases to the right</option><option value="reverse">X increases to the left</option></select></label>
   <label className="block">Ruida Y direction<select className="block min-h-12 w-full rounded border border-line bg-surface p-2" value={ruidaY} onChange={e=>setRuidaY(e.target.value as typeof ruidaY)} disabled={busy||blocked||!stationToken}><option value="">Check the panel coordinates</option><option value="forward">Y increases toward the top</option><option value="reverse">Y increases toward the bottom</option></select></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={axesConfirmed} onChange={e=>setAxesConfirmed(e.target.checked)} disabled={busy||blocked||!stationToken} /><span>I checked both axis directions and the sheet's lower left corner against the panel.</span></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={firstTubeConfirmed} onChange={e=>setFirstTubeConfirmed(e.target.checked)} disabled={busy||blocked||!stationToken} /><span>This machine cuts with laser tube 1. Tube 2 must remain off.</span></label>
   <button className={button} disabled={busy||blocked||!stationToken||!ruidaX||!ruidaY||!axesConfirmed||!firstTubeConfirmed} onClick={()=>void commission()}>Confirm Ruida setup</button>
  </div>}
  {report?.firmware==="forgefirm"&&report.needsCommissioning&&!report.commissioned&&<div className="space-y-3">
   <p>ForgeFIRM reports saved spindle settings before they take effect. Restart it from the machine's own panel after a settings change, then confirm here.</p>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={restartConfirmed} onChange={e=>setRestartConfirmed(e.target.checked)} disabled={busy||blocked||!stationToken} /><span>I restarted ForgeFIRM after its spindle settings changed and checked the machine's panel.</span></label>
   <button className={button} disabled={busy||blocked||!stationToken||!restartConfirmed} onClick={()=>void commission()}>Confirm firmware setup</button>
  </div>}
  {report?.firmware==="smoothieware"&&report.needsCommissioning&&!report.commissioned&&<div className="space-y-3">
   <p>Smoothieware reports settings from its configuration file. Restart the controller after editing that file, then check the laser and confirm here.</p>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={restartConfirmed} onChange={e=>setRestartConfirmed(e.target.checked)} disabled={busy||blocked||!stationToken} /><span>I restarted Smoothieware after its configuration changed and checked the laser.</span></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={coolantConfirmed} onChange={e=>setCoolantConfirmed(e.target.checked)} /><span>This configuration uses M8 and M9 for air assist.</span></label>
   <button className={button} disabled={busy||blocked||!stationToken||!restartConfirmed||!report.laserMode} onClick={()=>void commission()}>Confirm firmware setup</button>
  </div>}
  {report?.firmware==="marlin"&&report.needsCommissioning&&!report.commissioned&&<div className="space-y-3">
   <p>Marlin reports laser capability, but its power units come from the firmware build. Check that configuration before confirming this machine.</p>
   <label className="block">Marlin power units<select className="block min-h-12 w-full rounded border border-line bg-surface p-2" value={powerUnit} onChange={e=>setPowerUnit(e.target.value as typeof powerUnit)} disabled={busy||blocked||!stationToken}><option value="">Choose the build's units</option><option value="PWM">PWM, 0 to 255</option><option value="PERCENT">Percentage, 0 to 100</option></select></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={powerUnitConfirmed} onChange={e=>setPowerUnitConfirmed(e.target.checked)} /><span>I checked the build's power range against these units. Zero turns the beam off.</span></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={inlineConfirmed} onChange={e=>setInlineConfirmed(e.target.checked)} /><span>I checked inline laser power with M3 I and G1 S for this build.</span></label>
   <label className="flex items-start gap-3 min-h-12"><input type="checkbox" className="mt-1" checked={coolantConfirmed} onChange={e=>setCoolantConfirmed(e.target.checked)} /><span>This build supports M8 and M9 air assist.</span></label>
   <button className={button} disabled={busy||blocked||!stationToken||!report.canHome||!report.laserMode||!powerUnit||!powerUnitConfirmed||!inlineConfirmed} onClick={()=>void commission()}>Confirm firmware setup</button>
  </div>}
  {!stationToken&&<p>Authorize this screen before Home or firmware confirmation.</p>}
 </section>;
}
