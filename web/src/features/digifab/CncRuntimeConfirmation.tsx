import { useState } from "react";
import type { CncRuntimeRecovery } from "@cobblr/platform-contract/cnc";
export function CncRuntimeConfirmation({tools,onConfirm,onStop,busy}:{tools:CncRuntimeRecovery["tools"];onConfirm:(seconds:Record<string,number>)=>Promise<void>;onStop?:()=>void;busy:boolean}){
 const [values,setValues]=useState<Record<string,string>>({}),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const ready=tools.every(tool=>{const value=values[String(tool.number)];return value?.trim()&&Number.isFinite(Number(value))&&Number(value)>=tool.observedSeconds;});
 return <form className="rounded border border-line p-4 space-y-4" onSubmit={async event=>{event.preventDefault();if(!ready||busy||saving)return;setError("");setSaving(true);try{await onConfirm(Object.fromEntries(tools.map(tool=>[String(tool.number),Number(values[String(tool.number)])])));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}}}>
  <p>The bridge no longer has the final bit runtime. Enter actual seconds for every tool. Enter 0 for a tool that was never used. The machine must be idle before recording the outcome.</p>
  {tools.map(tool=><div key={tool.number} className="space-y-2"><label className="block space-y-2"><span>Tool {tool.number} actual seconds</span><input type="number" min={tool.observedSeconds} step="any" required disabled={busy||saving} className="min-h-12 w-full rounded border border-line bg-surface p-3" value={values[String(tool.number)]??""} onChange={event=>setValues(previous=>({...previous,[String(tool.number)]:event.target.value}))}/></label><p className="text-sm">{tool.observedSeconds} seconds already observed.</p></div>)}
  {error&&<p role="alert">{error}</p>}
  <div className="flex flex-wrap gap-3">{onStop&&<button type="button" className="min-h-12 rounded border border-red-500 px-4 py-3 text-red-600 dark:text-red-300" onClick={onStop}>Stop CNC</button>}<button className="min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50" disabled={!ready||busy||saving}>Record outcome and runtime</button></div>
 </form>;
}
