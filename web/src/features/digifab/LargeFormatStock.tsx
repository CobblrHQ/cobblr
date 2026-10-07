import {formatStockAmount} from "@cobblr/inventory/ui";
import {useState} from "react";
import {Link} from "react-router-dom";
import {useInfiniteQuery,useQuery} from "@tanstack/react-query";
import {SearchInput} from "@cobblr/platform-web";
import {api} from "../../lib/api";
const button="min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
export function LargeFormatStock({slug,station,supplies,onChanged}:{slug:string;station:string;supplies:Array<{supply_id:string;reading:{name:string}}>;onChanged:()=>Promise<unknown>}) {
 const [slot,setSlot]=useState("stock"),[search,setSearch]=useState(""),[pick,setPick]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const shape=slot==="stock"?"roll":"liquid";
 const q=useInfiniteQuery({queryKey:["large-format-stock",slug,station,shape,search],initialPageParam:0,queryFn:({pageParam})=>api.listWorkshopStock(slug,{station,shape,q:search,limit:100,offset:pageParam}),getNextPageParam:(last,_pages,offset)=>last.complete?undefined:offset+100});
 const loaded=useQuery({queryKey:["large-format-loaded",slug,station],queryFn:()=>api.listWorkshopStock(slug,{station,limit:1}),refetchInterval:4000});
 const records=useQuery({queryKey:["large-format-stock-links",slug,station,loaded.data?.loaded],queryFn:async()=>Promise.all((loaded.data?.loaded??[]).map(async i=>{const record=await api.workshopStock(slug,i.part_id),address=await api.recordAddress(slug,record.kind,i.part_id);return {...i,record,path:address.path};})),enabled:!!loaded.data});
 const load=async(id:string,isLoaded:boolean,target=slot)=>{if(busy)return;setBusy(true);setError("");try{await api.loadWorkshopStock(slug,id,{station,slot:target,loaded:isLoaded});setPick("");await q.refetch();await loaded.refetch();await onChanged();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const items=q.data?.pages.flatMap(p=>p.items)??[];
 return <section aria-label="Loaded roll and ink" className="rounded border border-line p-4 space-y-3"><h2 className="text-sm font-semibold">Loaded roll and ink</h2><p>Choose Roll stock in metres for media and Liquid stock in ml for each ink cartridge. Confirm the roll matches the printer.</p><Link className={`${button} inline-flex items-center`} to="/inventory">Create or reorder stock in Inventory</Link>
 <ul>{records.data?.map(i=><li key={i.slot} className="flex flex-wrap items-center gap-3 py-2"><span>{i.slot==="stock"?"Roll":supplies.find(s=>`ink:${s.supply_id}`===i.slot)?.reading.name??i.slot}: {i.record.name}, {formatStockAmount(i.record.remaining,i.record.unit)}</span><Link className={button} to={i.path}>View stock and reorder</Link><button className={button} disabled={busy} onClick={()=>void load(i.part_id,false,i.slot)}>Unload {i.slot==="stock"?"roll":"ink"}</button></li>)}</ul>
 <details><summary className="min-h-12 flex items-center cursor-pointer">Load or replace stock</summary><div className="space-y-3">
 <label className="block">Stock slot<select className="w-full min-h-12 bg-surface border border-line rounded p-3" value={slot} onChange={e=>{setSlot(e.target.value);setPick("");}}><option value="stock">Roll media</option>{supplies.map(s=><option key={s.supply_id} value={`ink:${s.supply_id}`}>{s.reading.name}</option>)}</select></label>
 <label className="block">Find stock<SearchInput value={search} onChange={value=>{setSearch(value);setPick("");}} placeholder="Find stock"/></label>
 <label className="block">Stock record<select className="w-full min-h-12 bg-surface border border-line rounded p-3" value={pick} onChange={e=>setPick(e.target.value)}><option value="">Choose stock</option>{items.filter(i=>i.remaining>0).map(i=><option key={i.id} value={i.id}>{i.name}: {formatStockAmount(i.remaining,i.unit)}</option>)}</select></label>
 {q.hasNextPage&&<button className={button} disabled={q.isFetchingNextPage} onClick={()=>void q.fetchNextPage()}>More stock</button>}
 <button className={button} disabled={busy||!pick} onClick={()=>void load(pick,true)}>Confirm stock is loaded</button></div></details>
 {(error||q.error||loaded.error)&&<p role="alert">{error||"Stock could not be read. Check Inventory."}</p>}
 </section>;
}
