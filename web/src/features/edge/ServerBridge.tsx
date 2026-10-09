import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {api} from "../../lib/api";
export function ServerBridge({slug}:{slug:string}){
 const queryClient=useQueryClient();
 const state=useQuery({queryKey:["server-bridge",slug],queryFn:()=>api.getServerBridge(slug),enabled:!!slug,refetchInterval:10000});
 const change=useMutation({mutationFn:(enabled:boolean)=>api.setServerBridge(slug,enabled),onSuccess:async()=>{await queryClient.invalidateQueries({queryKey:["server-bridge",slug]});await queryClient.invalidateQueries({queryKey:["edge-status",slug]});await queryClient.invalidateQueries({queryKey:["edge-bridges",slug]});}});
 return <section className="rounded-xl border border-line p-4 space-y-3">
  <h2 className="text-sm font-semibold">Server bridge</h2>
  {state.data?.reason==="cloud"?<p>This cloud server cannot reach your LAN. Install one bridge on your network for your networked machines. USB machines use a bridge on a Pi or a nearby Linux, Windows or Mac computer.</p>:state.data?.reason==="not_configured"?<p>Enable the optional bridge service in your Cobblr Server compose stack, then use it here. It serves networked machines without installing a bridge on each computer.</p>:state.data?<><p>One bridge on Cobblr Server can serve your networked machines. USB machines use a bridge on a nearby computer.</p><button type="button" className="min-h-12 rounded border border-line px-4 py-3" disabled={change.isPending} onClick={()=>change.mutate(!state.data!.enabled)}>{state.data.enabled?"Turn off the server bridge":"Use the server bridge"}</button>{state.data.enabled&&<p>Paired with this workspace. Choose Cobblr Server when you add a networked machine.</p>}</>:state.isLoading?<p>Checking the server bridge…</p>:null}
  {(state.error||change.error)&&<p role="alert">{String(state.error||change.error)}</p>}
 </section>;
}
