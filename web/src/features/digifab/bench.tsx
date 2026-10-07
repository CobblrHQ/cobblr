import { instrumentReadingText } from "@cobblr/platform-contract/instrument-reading";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { SearchInput, useToast } from "@cobblr/platform-web";
import { api, type BenchReport, type PlatformResolvedEntity } from "../../lib/api";
import type { EntityDetailPanelCtx } from "../../panels/types";
export function BenchPanel({ctx}:{ctx:EntityDetailPanelCtx}){
 const {slug,entityId:machineId}=ctx,qc=useQueryClient(),toast=useToast();
 const [busy,setBusy]=useState(false),[report,setReport]=useState<BenchReport|null>(null),[identity,setIdentity]=useState(""),[offset,setOffset]=useState(0);
 const [kind,setKind]=useState("inventory:part"),[search,setSearch]=useState(""),[record,setRecord]=useState<PlatformResolvedEntity|null>(null);
 const key=["bench",slug,machineId,offset];
 const page=useQuery({queryKey:key,queryFn:()=>api.readBench(slug,machineId,offset)});
 const kinds=useQuery({queryKey:["entity-kinds",slug],queryFn:()=>api.listEntityKinds(slug),enabled:!!page.data?.instrument});
 const choices=useQuery({queryKey:["bench-records",slug,kind,search],queryFn:()=>api.listEntities(slug,kind,search || undefined),enabled:!!page.data?.instrument&&!record});
 async function operate(operation:"identify"|"read"|"log"|"output_off"){
  setBusy(true);
  try{
   const result=await api.operateBench(slug,{machine_id:machineId,operation,...(operation==="log"&&record?{record_kind:record.kind,record_id:record.id}:{})});
   if(operation==="identify"&&"identity" in result)setIdentity(result.identity);
   if(operation==="read"&&"readings" in result)setReport(result);
   if(operation==="log"&&"report" in result){setReport(result.report);setOffset(0);await qc.invalidateQueries({queryKey:["bench",slug,machineId]});toast.success(`Reading saved to ${record?.title || "the record"}.`);}
   if(operation==="output_off")toast.success("The instrument confirmed its selected output is off.");
  }catch(error){toast.error(error instanceof Error?error.message:"The instrument did not answer.");}finally{setBusy(false);}
 }
 if(!page.data||(!page.data.instrument&&!page.data.total))return null;
 const instrument=page.data.instrument;
 return <section className="rounded-lg border border-line p-3 space-y-3" data-testid="bench-instrument">
  <h3 className="text-sm font-semibold text-content">Bench instrument</h3>
  <p className="text-sm text-muted break-words">{identity || instrument?.identity || instrument?.name || "Saved instrument readings"}</p>
  <p className="text-sm text-muted">Readings leave instrument settings alone. Set up measurements on the instrument.</p>
  {!instrument&&<p className="text-sm text-muted">{page.data.connection_error || "Reconnect this instrument to collect more readings."}</p>}
  {instrument&&<div className="flex flex-wrap gap-2">
   <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("identify")}>Identify</button>
   <button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("read")}>Read</button>
   {instrument.output_off&&<button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={busy} onClick={()=>void operate("output_off")}>Output off</button>}
  </div>}
  {report&&<div aria-live="polite" className="space-y-2"><p className="text-sm text-muted">{report.at}</p><Measurements report={report}/>{report.screenshot&&<img className="max-w-full rounded" alt="Scope reading" src={`data:${report.screenshot.mime_type};base64,${report.screenshot.data_b64}`}/>}</div>}
  {instrument&&<div className="space-y-2">
   <h4 className="text-sm font-medium">Keep a reading on a record</h4>
   {record?<div className="flex flex-wrap items-center gap-2"><span className="text-sm break-words">{record.title}</span><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" onClick={()=>setRecord(null)}>Change record</button></div>:<>
    <label className="block text-sm">Record collection<select aria-label="Record collection" className="input w-full min-h-11" value={kind} onChange={e=>{setKind(e.target.value);setSearch("");}}>{(kinds.data?.items || []).filter(k=>k.id!=="digifab:instrument-reading").map(k=><option key={k.id} value={k.id}>{k.display_name}</option>)}</select></label>
    <SearchInput aria-label="Find a record" placeholder="Find a board or test run" value={search} onChange={setSearch}/>
    <ul className="max-h-44 overflow-y-auto divide-y divide-line">{choices.data?.items.map(item=><li key={item.id}><button type="button" className="w-full min-h-11 px-2 text-left text-sm break-words" onClick={()=>setRecord(item)}>{item.title}</button></li>)}</ul>
    {choices.data&&!choices.data.items.length&&<p className="text-sm text-muted">No records found in this collection.</p>}
   </>}
   <button type="button" className="min-h-11 rounded-md bg-accent px-3 text-sm text-white disabled:opacity-50" disabled={busy||!record} onClick={()=>void operate("log")}>{busy?"Waiting for instrument…":"Log fresh reading"}</button>
  </div>}
  <h4 className="text-sm font-medium">Saved readings ({page.data.total})</h4>
  <ul className="space-y-3">{page.data.items.map(row=><li key={row.id} className="border-t border-line pt-2 space-y-1"><p className="text-xs text-muted">{row.report.at}</p><Measurements report={row.report}/><RecordLink slug={slug} kind={row.record_kind} id={row.record_id}/>{row.screenshot_file_id&&<Link className="text-sm text-accent" to={`/w/${slug}/files/${row.screenshot_file_id}`}>Scope screenshot</Link>}</li>)}</ul>
  <div className="flex gap-2"><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous readings</button><button type="button" className="min-h-11 rounded-md border border-line px-3 text-sm text-content hover:bg-subtle disabled:opacity-50" disabled={offset+page.data.items.length>=page.data.total} onClick={()=>setOffset(offset+20)}>More readings</button></div>
 </section>;
}
function Measurements({report}:{report:BenchReport}){return <dl className="space-y-1">{report.readings.map(r=><div key={r.quantity} className="flex flex-wrap gap-2 text-sm"><dt className="capitalize">{r.quantity}</dt><dd className="font-mono">{instrumentReadingText(r.value,r.unit)}</dd></div>)}</dl>;}
function RecordLink({slug,kind,id}:{slug:string;kind:string;id:string}){
 const record=useQuery({queryKey:["entity",slug,kind,id],queryFn:()=>api.lookupEntity(slug,kind,id)});
 if(!record.data)return <span className="text-xs text-muted">Record unavailable</span>;
 return <Link className="text-sm text-accent break-words" to={`/w/${slug}${record.data.detailUrl}`}>{record.data.title}</Link>;
}
