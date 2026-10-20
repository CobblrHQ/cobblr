import {useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Modal} from "@cobblr/platform-web";
import {sha256} from "@noble/hashes/sha2.js";
import {bytesToHex} from "@noble/hashes/utils.js";
import {bridgeDiscoveryIdentity,type FoundBridgeDevice} from "@cobblr/platform-contract/bridge-discovery";
import {api,type EdgeBridge} from "../../lib/api";
import {useHosted} from "../../lib/useHosted";
import {HomeNetworkHint} from "../../components/HomeNetworkHint";
import {BridgePicker} from "../../components/BridgePicker";
import {EdgeBridgeSetup} from "../digifab/fleet";
const printerKinds:Record<string,string>={"klipper-moonraker":"Klipper (Moonraker)",octoprint:"OctoPrint",prusalink:"PrusaLink","duet-rrf":"Duet (RepRapFirmware)",bambu:"Bambu Lab"};
export function FoundDevices({slug,bridges}:{slug:string;bridges:EdgeBridge[]}){
 const hosted=useHosted();
 const [bridge,setBridge]=useState<string|null>(bridges[0]?.bridge||null);
 const [selected,setSelected]=useState<FoundBridgeDevice|null>(null);
 const qc=useQueryClient();
 const connected=bridges.some(item=>item.bridge===bridge&&item.connected);
 const connections=useQuery({queryKey:["digifab-connections",slug],queryFn:()=>api.listDigifabConnections(slug),enabled:!!slug&&bridges.length>0});
 const found=useQuery({queryKey:["edge-discovery",slug,bridge],queryFn:()=>api.discoverBridgeDevices(slug,bridge),enabled:!!slug&&connected,refetchInterval:30_000,retry:false});
 if(!bridges.length)return null;
 const items=found.data?.items.filter(device=>!connections.data?.items.some(connection=>{
  const config=connection.config;
  if(connection.type!=="edge_adapter"||config?.bridge!==bridge||config?.driver!==device.driver)return false;
  const identity=bridgeDiscoveryIdentity({driver:device.driver,...device.config});
  return !!identity&&config.discovery_key===bytesToHex(sha256(new TextEncoder().encode(identity)));
 }))||[];
 return <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
  <h2 className="text-sm font-semibold">Find machines</h2>
  <p className="text-sm text-muted">USB machines and advertised LAN controllers appear here. Choose a device, name it and finish its setup. Discovery does not start a job.</p>
  <BridgePicker slug={slug} value={bridge} onChange={setBridge}/>
  <button type="button" className="rounded border border-line px-4 py-3 min-h-12" disabled={!connected||found.isFetching} onClick={()=>void found.refetch()}>{found.isFetching?"Looking for machines…":"Scan for machines"}</button>
  {!connected&&<p className="text-sm text-muted">Connect this bridge to look for machines on its bench and network.</p>}
  {found.error&&<p role="alert" className="text-sm text-danger">{found.error instanceof Error?found.error.message:"This bridge could not scan for devices."}</p>}
  {found.data?.warnings.map(warning=><p key={warning} className="text-sm text-muted">{warning}</p>)}
  {found.data&&items.length===0&&<p className="text-sm text-muted">No devices were found. Some controllers need their address entered manually. Plug USB machines into the computer running this bridge.</p>}
  <ul className="space-y-2">{items.map(device=><li key={device.id} className="rounded-lg border border-line p-3 space-y-2">
   <p className="font-medium text-sm">New device found: {device.name}</p>
   <p className="text-sm text-muted break-all">{device.address}</p>
   {device.kind&&<p className="text-sm text-muted">{printerKinds[device.kind]||device.kind}{device.model?` · ${device.model}`:""}{device.serial?` · ${device.serial}`:""}</p>}
   {device.transport==="lan"&&<HomeNetworkHint address={device.address} hosted={hosted} throughBridge/>}
   {device.note&&<p className="text-sm text-muted">{device.note}</p>}
   {device.driver?<button type="button" className="rounded bg-accent text-white px-4 py-3 disabled:opacity-50 min-h-12" onClick={()=>setSelected(device)}>Name and add</button>:<Link className="rounded border border-line px-4 py-3 inline-flex items-center min-h-12" to="/configuration/print">Set up this machine</Link>}
  </li>)}</ul>
  {selected&&<Modal open title={`Add ${selected.name}`} onClose={()=>setSelected(null)} size="lg">
   <EdgeBridgeSetup presetDriver={selected.driver||undefined} presetName={selected.name} presetConfig={selected.config} presetBridge={bridge} onClose={()=>setSelected(null)} onCreated={()=>{setSelected(null);void qc.invalidateQueries({queryKey:["digifab-connections",slug]});}}/>
  </Modal>}
 </section>;
}
