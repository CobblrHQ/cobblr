import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
export function DirectLaserControls({slug,connectionId,deviceId,status,onAccepted}:{slug:string;connectionId:string;deviceId:string;status?:string;onAccepted?:()=>void}) {
 const qc=useQueryClient(),[error,setError]=useState("");
 const request=useMutation({mutationKey:["direct-laser-control",slug,connectionId,deviceId],mutationFn:async(id:string)=>{
  await api.runDigifabControl(slug,connectionId,deviceId,id);
  await qc.invalidateQueries({queryKey:["digifab-fleet",slug]});
  onAccepted?.();
 }});
 const control=async(id:string)=>{
  setError("");
  try{await request.mutateAsync(id);}
  catch(e){setError(e instanceof Error?e.message:String(e));}
 };
 return <div className="space-y-2" aria-label="Direct laser controls"><div className="flex flex-wrap gap-3">
  {status!=="paused"&&<button className="min-h-12 rounded border border-line px-4 py-3" onClick={()=>void control("pause")}>Pause</button>}
  {status==="paused"&&<button className="min-h-12 rounded border border-line px-4 py-3" onClick={()=>void control("resume")}>Resume</button>}
  <button className="min-h-12 rounded bg-red-700 text-white px-4 py-3 font-semibold" onClick={()=>void control("stop")}>Stop laser</button>
 </div>{error&&<p role="alert" className="break-words">{error}</p>}</div>;
}
