import { useState } from "react";
import type { CncStationStock } from "@cobblr/platform-contract/cnc";
export function CncStockDetails({item,onSave,busy}:{item:CncStationStock;onSave:(id:string,fields:Record<string,number>)=>Promise<void>;busy:boolean}) {
 const bit=item.shape==="wearing_tool";
 const keys=bit?["diameter"] as const:["width","height","thickness"] as const;
 const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(keys.map(key=>[key,item[key]==null?"":String(item[key])])));
 const [error,setError]=useState("");
 return <details className="rounded border border-line p-3"><summary className="min-h-12 cursor-pointer py-3">{bit?"Bit diameter":"Block dimensions"}</summary><form className="space-y-3" onSubmit={async event=>{event.preventDefault();setError("");try{const fields=Object.fromEntries(keys.map(key=>[`${key}_mm`,Number(values[key])]));if(Object.values(fields).some(v=>!Number.isFinite(v)||v<=0))throw new Error("Enter positive measurements in millimetres.");await onSave(item.id,fields);}catch(e){setError(e instanceof Error?e.message:String(e));}}}>{keys.map(key=><label key={key} className="block capitalize">{key} (mm)<input className="min-h-12 w-full rounded border border-line bg-surface p-3" type="number" min="0.000001" step="any" required value={values[key]??""} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>)}{error&&<p role="alert">{error}</p>}<button className="min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50" disabled={busy}>{bit?"Save bit diameter":"Save block dimensions"}</button></form></details>;
}
