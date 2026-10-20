import {Link} from "react-router-dom";
import {useContext} from "react";
import {isWebSerialAvailable} from "@cobblr/platform-web";
import {BrowserLaserContext} from "./BrowserLaser";
export function BrowserLaserOption(){
 const state=useContext(BrowserLaserContext);
 if(!state)return null;
 const supported=isWebSerialAvailable();
 return <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
  <h2 className="text-sm font-semibold">One USB GRBL laser from this browser</h2>
  <p className="text-sm text-muted">For a small setup, Chrome or Edge on a laptop or Chromebook can connect directly to a USB GRBL laser. Keep this tab open and awake for the whole job. A bridge is recommended for long jobs.</p>
  {!supported&&<p className="text-sm text-muted">This browser has no USB Web Serial. Chrome on Android, iPad browsers, Safari and Firefox need a bridge on a nearby computer.</p>}
  {state.error&&<p role="alert" className="text-sm text-danger">{state.error}</p>}
  {state.machine?<div className="flex flex-wrap items-center gap-3"><Link className="rounded bg-accent text-white px-4 py-3 disabled:opacity-50 inline-flex items-center min-h-12" to={`/station/machine/${state.machine.connectionId}/gcode-laser`}>Open this machine station</Link><button type="button" className="rounded border border-line px-4 py-3 min-h-12" onClick={()=>void state.disconnect()}>Stop and disconnect USB</button></div>:<button type="button" className="rounded bg-accent text-white px-4 py-3 disabled:opacity-50 min-h-12" disabled={!supported||state.busy} onClick={()=>void state.connect()}>{state.busy?"Connecting USB laser…":"Connect USB GRBL in this tab"}</button>}
 </section>;
}
export function BrowserLaserStationNote({connectionId}:{connectionId:string}){
 const state=useContext(BrowserLaserContext);
 if(state?.machine?.connectionId!==connectionId)return null;
 return <section className="rounded border border-line p-4 space-y-3"><p>This tab drives the USB laser. Keep it open and awake until the job finishes. A bridge is recommended for long jobs.</p><button type="button" className="min-h-12 rounded border border-line px-4" onClick={()=>void state.disconnect()}>Stop and disconnect USB</button></section>;
}
