import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";

export interface OwnConnections {
  items: Array<{id: string; status: string; peer_url: string | null; peer_workspace_name: string | null}>;
  destinations: Array<{index: number; label: string; note: string | null; cloud: boolean}>;
}

export function ConnectCobblr() {
  const {api, orgSlug} = usePlatformWeb();
  const qc = useQueryClient();
  const [where, setWhere] = useState<number | undefined>();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const connections = useQuery({queryKey: ["own-connections", orgSlug], queryFn: () => api.ownConnections!(orgSlug), enabled: !!api.ownConnections});
  if (!api.ownConnections || !api.connectCobblr || !api.revokeOwnConnection) return null;
  const destination = connections.data?.destinations.find((d) => d.index === (where ?? connections.data?.destinations[0]?.index));
  async function create() {
    setBusy(true); setFailure("");
    try {const made = await api.connectCobblr!(orgSlug, where); setLink(made.invite_url); await qc.invalidateQueries({queryKey: ["own-connections", orgSlug]});}
    catch (e) {setFailure((e as Error).message);} finally {setBusy(false);}
  }
  return <section className="space-y-3 rounded border border-line p-3" data-testid="connect-cobblr">
    <h2 className="font-medium">Connect your other Cobblr</h2>
    <p className="text-sm text-muted">Sign in there and approve an existing workspace. The connection sends only items you choose. Both workspaces stay yours.</p>
    <label className="block text-sm">Your other Cobblr<select aria-label="Your other Cobblr" value={where ?? connections.data?.destinations[0]?.index ?? ""} onChange={(e) => {setWhere(Number(e.target.value)); setLink("");}} className="mt-1 w-full rounded border border-line bg-surface p-2 text-base">{connections.data?.destinations.map((d) => <option key={d.index} value={d.index}>{d.label}</option>)}</select></label>
    {destination?.note && <p className="text-sm">{destination.note} You can use a send file instead.</p>}
    <button type="button" disabled={busy || !destination} onClick={() => void create()} className="rounded border border-line px-3 py-2">Make connection link</button>
    {link && <div className="space-y-2"><a href={link} target="_blank" rel="noreferrer" className="text-accent underline">Open on your other Cobblr</a><label className="block text-sm">Connection link<input aria-label="Connection link" readOnly value={link} className="mt-1 w-full rounded border border-line bg-surface p-2" onFocus={(e) => e.target.select()} /></label><button type="button" onClick={() => void qc.invalidateQueries()} className="rounded border border-line px-3 py-2">Refresh after approval</button></div>}
    {connections.data?.items.map((c) => <div key={c.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm"><span className="min-w-0 flex-1">{c.peer_workspace_name || "Awaiting approval"}{c.peer_url ? ` on ${new URL(c.peer_url).host}` : ""} · {c.status}</span><button type="button" disabled={busy} className="rounded border border-line px-2 py-1" onClick={async () => {setBusy(true);setFailure("");try {await api.revokeOwnConnection!(orgSlug,c.id); await qc.invalidateQueries();} catch(e) {setFailure((e as Error).message);} finally {setBusy(false);}}}>Revoke connection</button></div>)}
    <p className="text-xs text-muted">Revoking stops sends. It keeps both workspaces and the items already sent.</p>
    {(failure || connections.isError) && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{failure || (connections.error as Error).message}</p>}
  </section>;
}
