import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
export function ESPHomeBenchDiscovery({slug,bridge,onFound}:{slug:string;bridge:string|null;onFound:(device:{name:string;host:string;port:number})=>void}){
 const [items,setItems]=useState<{name:string;host:string;port:number}[]>([]),[searched,setSearched]=useState(false);
 const discovery=useMutation({mutationFn:async()=>{const result=await api.discoverBenchESPHome(slug,bridge);setItems(result.items);setSearched(true);}});
 return <div className="col-span-2 space-y-2 text-sm"><button type="button" className="min-h-11 rounded border border-line px-3 py-2 disabled:opacity-50" disabled={discovery.isPending} onClick={()=>discovery.mutate()}>{discovery.isPending?"Looking on your network…":"Find ESPHome devices"}</button>{discovery.error&&<p role="alert">{discovery.error.message}</p>}{searched&&!items.length&&<p>No ESPHome devices replied. Enter its host or check the bridge is on the same network.</p>}{items.map(item=><div key={item.host} className="rounded border border-line p-2"><p>{item.name} at {item.host}:{item.port}</p><button type="button" className="min-h-11 underline" onClick={()=>onFound(item)}>Use {item.name}</button></div>)}</div>;
}
