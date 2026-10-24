import { instrumentReadingText } from "@cobblr/platform-contract/instrument-reading";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchInput, useToast, useConfirm, useImageSrc, WorkspaceLink } from "@cobblr/platform-web";
import { api, type BenchReport, type BenchOperation, type BenchCapture, type PlatformResolvedEntity } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import type { EntityDetailPanelCtx } from "../../panels/types";
export function BenchPanel({ctx}:{ctx:EntityDetailPanelCtx}){
 return <BenchInstrument slug={ctx.slug} machineId={ctx.entityId}/>;
}
export function BenchInstrument({slug,machineId}:{slug:string;machineId:string}){
 const qc=useQueryClient(),toast=useToast(),confirm=useConfirm(),{activeOrg}=useActiveOrg();
 const [channels,setChannels]=useState("D0,D1"),[rate,setRate]=useState("1000000"),[duration,setDuration]=useState("1000"),[trigger,setTrigger]=useState(""),[decoder,setDecoder]=useState("uart"),[options,setOptions]=useState("tx=D0:baudrate=115200"),[voltage,setVoltage]=useState("3.3"),[current,setCurrent]=useState("0.1");
 const [busy,setBusy]=useState(false),[report,setReport]=useState<BenchReport|null>(null),[identity,setIdentity]=useState(""),[offset,setOffset]=useState(0);
 const [kind,setKind]=useState("inventory:part"),[search,setSearch]=useState(""),[record,setRecord]=useState<PlatformResolvedEntity|null>(null);
 const key=["bench",slug,machineId,offset];
 const page=useQuery({queryKey:key,queryFn:()=>api.readBench(slug,machineId,offset)});
 const kinds=useQuery({queryKey:["entity-kinds",slug],queryFn:()=>api.listEntityKinds(slug),enabled:!!page.data?.instrument});
 const choices=useQuery({queryKey:["bench-records",slug,kind,search],queryFn:()=>api.listEntities(slug,kind,search || undefined),enabled:!!page.data?.instrument&&!record});
 async function operate(operation:BenchOperation["operation"],extra:Partial<BenchOperation>={}){
  if(["output_on","set_voltage","set_current"].includes(operation)){
   if(!await confirm({title:operation==="output_on"?"Turn output on?":"Change the supply set point?",message:operation==="output_on"?"This powers the connected circuit.":`This changes the supply to ${extra.value} ${operation==="set_voltage"?"V":"A"}.`,confirmLabel:"Confirm change"}))return;
   extra.confirmed=true;
  }
  setBusy(true);
  try{
   const result=await api.operateBench(slug,{machine_id:machineId,operation,...extra,...((operation==="log"||operation==="capture")&&record?{record_kind:record.kind,record_id:record.id}:{})});
   if(operation==="identify"&&"identity" in result)setIdentity(result.identity);
   if(operation==="read"&&"readings" in result)setReport(result);
   if((operation==="log"||operation==="capture")&&"report" in result){setReport(result.report);setOffset(0);await qc.invalidateQueries({queryKey:["bench",slug,machineId]});toast.success(`Reading saved to ${record?.title || "the record"}.`);}
   if(operation==="configure"){await qc.invalidateQueries({queryKey:["bench",slug,machineId]});toast.success("Instrument control settings saved.");}
   if(["output_on","set_voltage","set_current"].includes(operation))toast.success("The instrument confirmed the change.");
   if(operation==="output_off")toast.success("The instrument confirmed its selected output is off.");
  }catch(error){toast.error(error instanceof Error?error.message:"The instrument did not answer.");}finally{setBusy(false);}
 }
 function capture(data_b64?:string){
  const decoder_options=Object.fromEntries(options.split(":").filter(Boolean).map(pair=>{const [key,...value]=pair.split("=");return [key,value.join("=")];}));
  const settings:BenchCapture={channels:channels.split(",").map(c=>c.trim()),samplerate:Number(rate),duration_ms:Number(duration),...(trigger?{trigger}:{}),...(decoder?{decoder:decoder as BenchCapture["decoder"],decoder_options}:{}),...(data_b64?{data_b64}:{})};
  void operate("capture",{capture:settings});
 }
 async function importCapture(file:File){
  if(file.size>2*1024*1024){toast.error("Choose a .sr capture of at most 2 MB.");return;}
  const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);capture(btoa(binary));
 }
 if(!page.data||(!page.data.instrument&&!page.data.total))return null;
 const instrument=page.data.instrument;
 return <section className="rounded-lg border border-line p-3 space-y-3" data-testid="bench-instrument">
  <h3 className="text-sm font-semibold text-content">Bench instrument</h3>
  <p className="text-sm text-muted break-words">{identity || instrument?.identity || instrument?.name || "Saved instrument readings"}</p>
  <p className="text-sm text-muted">Readings leave instrument settings alone. Set up measurements on the instrument.</p>
  {instrument?.profile==="riden"&&<p className="text-sm text-muted">Supply control is {instrument.control_enabled?"enabled":"off"}. Every change needs confirmation. Output off is always available.</p>}
  {!instrument&&<p className="text-sm text-muted">{page.data.connection_error || "Reconnect this instrument to collect more readings."}</p>}
  {instrument&&<div className="flex flex-wrap gap-2">
   <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("identify")}>Identify</button>
   {instrument.profile!=="sigrok"&&<button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("read")}>Read</button>}
   {instrument.output_off&&<button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("output_off")}>Output off</button>}
  </div>}
  {instrument?.profile==="riden"&&<div className="space-y-2">
   {activeOrg?.role==="owner"&&<label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={instrument.control_enabled===true} disabled={busy} onChange={e=>void operate("configure",{control_enabled:e.target.checked})}/>Allow control for this instrument</label>}
   {instrument.control_enabled&&<div className="space-y-2">
    <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm" disabled={busy} onClick={()=>void operate("output_on")}>Output on</button>
    <label className="block text-sm">Voltage set point (V)<input className="input w-full min-h-11" type="number" min="0" max="60" step="0.01" value={voltage} onChange={e=>setVoltage(e.target.value)}/></label><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm" disabled={busy} onClick={()=>void operate("set_voltage",{value:Number(voltage)})}>Set voltage</button>
    <label className="block text-sm">Current limit (A)<input className="input w-full min-h-11" type="number" min="0" max="18" step="0.001" value={current} onChange={e=>setCurrent(e.target.value)}/></label><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm" disabled={busy} onClick={()=>void operate("set_current",{value:Number(current)})}>Set current limit</button>
   </div>}
  </div>}
  {/* EXTERNAL-IMAGE-OK: the instrument screenshot is an inline data URI, never a stored file path. */}
  {/* photo-frame: an oscilloscope screenshot shown whole beside its readings. */}
  {report&&<div aria-live="polite" className="space-y-2"><p className="text-sm text-muted">{report.at}</p><Measurements report={report}/>{report.screenshot&&<img className="max-w-full rounded" alt="Scope reading" src={`data:${report.screenshot.mime_type};base64,${report.screenshot.data_b64}`}/>}</div>}
  {instrument?.profile==="sigrok"&&<div className="space-y-2">
   <label className="block text-sm">Channels<input className="input w-full min-h-11" value={channels} onChange={e=>setChannels(e.target.value)}/></label>
   <label className="block text-sm">Sample rate (Hz)<input className="input w-full min-h-11" type="number" value={rate} onChange={e=>setRate(e.target.value)}/></label>
   <label className="block text-sm">Duration (ms)<input className="input w-full min-h-11" type="number" min="1" max="10000" value={duration} onChange={e=>setDuration(e.target.value)}/></label>
   <label className="block text-sm">Trigger (optional)<input className="input w-full min-h-11" placeholder="D0=r" value={trigger} onChange={e=>setTrigger(e.target.value)}/></label>
   <label className="block text-sm">Protocol decoder<select className="input w-full min-h-11" value={decoder} onChange={e=>{setDecoder(e.target.value);setOptions("");}}><option value="">No decode</option>{["uart","i2c","spi","can","onewire_link"].map(d=><option key={d} value={d}>{d==="onewire_link"?"1-Wire":d.toUpperCase()}</option>)}</select></label>
   {decoder&&<label className="block text-sm">Decoder options<input className="input w-full min-h-11" placeholder="tx=D0:baudrate=115200" value={options} onChange={e=>setOptions(e.target.value)}/></label>}
  </div>}
  {instrument&&<div className="space-y-2">
   <h4 className="text-sm font-medium">Keep a reading on a record</h4>
   {record?<div className="flex flex-wrap items-center gap-2"><span className="text-sm break-words">{record.title}</span><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" onClick={()=>setRecord(null)}>Change record</button></div>:<>
    <label className="block text-sm">Record collection<select aria-label="Record collection" className="input w-full min-h-11" value={kind} onChange={e=>{setKind(e.target.value);setSearch("");}}>{(kinds.data?.items || []).filter(k=>k.id!=="digifab:instrument-reading").map(k=><option key={k.id} value={k.id}>{k.display_name}</option>)}</select></label>
    <SearchInput aria-label="Find a record" placeholder="Find a board or test run" value={search} onChange={setSearch}/>
    {/* The records arrive after Log fresh reading is drawn: their box holds its room from the start, so a late row never moves the button under a finger (#8042). */}
    <div className="h-44 overflow-y-auto" data-testid="bench-record-choices">
     {choices.data?<ul className="divide-y divide-line">{choices.data.items.map(item=><li key={item.id}><button type="button" className="w-full min-h-11 px-2 text-left text-sm break-words" onClick={()=>setRecord(item)}>{item.title}</button></li>)}</ul>:<p className="text-sm text-muted">{choices.isError?"The records could not be read.":"Reading records…"}</p>}
     {choices.data&&!choices.data.items.length&&<p className="text-sm text-muted">No records found in this collection.</p>}
    </div>
   </>}
   {instrument.profile==="sigrok"?<><button type="button" className="min-h-11 rounded-md bg-accent px-3 text-sm text-white disabled:opacity-50" disabled={busy||!record} onClick={()=>capture()}>{busy?"Waiting for analyser…":"Start capture"}</button><label className="block text-sm">Import .sr<input className="block w-full min-h-11" type="file" accept=".sr" disabled={busy||!record} onChange={e=>{const file=e.target.files?.[0];if(file)void importCapture(file);e.target.value="";}}/></label></>:<button type="button" className="min-h-11 rounded-md bg-accent px-3 text-sm text-white disabled:opacity-50" disabled={busy||!record} onClick={()=>void operate("log")}>{busy?"Waiting for instrument…":"Log fresh reading"}</button>}
  </div>}
  <h4 className="text-sm font-medium">Saved readings ({page.data.total})</h4>
  <ul className="space-y-3">{page.data.items.map(row=><li key={row.id} className="border-t border-line pt-2 space-y-1"><p className="text-xs text-muted">{row.report.at}</p><Measurements report={row.report}/><RecordLink slug={slug} kind={row.record_kind} id={row.record_id}/>{row.capture_file_id&&<CaptureDownload slug={slug} id={row.capture_file_id}/>} {row.screenshot_file_id&&<WorkspaceLink className="text-sm text-accent" slug={slug} to={`/files/${row.screenshot_file_id}`}>Scope screenshot</WorkspaceLink>}</li>)}</ul>
  <div className="flex gap-2"><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous readings</button><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={offset+page.data.items.length>=page.data.total} onClick={()=>setOffset(offset+20)}>More readings</button></div>
 </section>;
}
function Measurements({report}:{report:BenchReport}){return <><dl className="space-y-1">{report.readings.map(r=><div key={r.quantity} className="flex flex-wrap gap-2 text-sm"><dt className="capitalize">{r.quantity.replaceAll("_"," ")}</dt><dd className="font-mono">{instrumentReadingText(r.value,r.unit)}</dd></div>)}</dl>{report.protection&&<p className="text-sm">Protection: {report.protection}. Output: {report.output_enabled?"on":"off"}.</p>}{report.capture&&<pre className="whitespace-pre-wrap break-all text-sm font-mono">{report.capture.decoded || "No protocol decode requested."}</pre>}</>;}
function RecordLink({slug,kind,id}:{slug:string;kind:string;id:string}){
 const record=useQuery({queryKey:["entity",slug,kind,id],queryFn:()=>api.lookupEntity(slug,kind,id)});
 if(!record.data)return <span className="text-xs text-muted">Record unavailable</span>;
 return <WorkspaceLink className="text-sm text-accent break-words" slug={slug} to={`${record.data.detailUrl}`}>{record.data.title}</WorkspaceLink>;
}

function CaptureDownload({slug,id}:{slug:string;id:string}){const url=useImageSrc(api.fileRawUrl(slug,id,"original"));return <div><a className="text-sm text-accent" href={url || undefined} download="logic-capture.sr">Download .sr</a><p className="text-xs text-muted">Open the downloaded .sr in PulseView on your desktop.</p></div>;}
