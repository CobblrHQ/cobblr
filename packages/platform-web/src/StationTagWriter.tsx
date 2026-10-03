import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScanStation, StationCommand } from "@cobblr/platform-contract/scan-station";

export interface StationTagClient {
  list(): Promise<{ items: ScanStation[] }>;
  queue(id: string, type: "write" | "link", url: string): Promise<StationCommand>;
  cancel(id: string): Promise<unknown>;
}

export function StationTagWriter({ client, workspace, url }: { client: StationTagClient; workspace: string; url: string }) {
  const [chosen, setChosen] = useState("");
  const qc = useQueryClient();
  const key = ["station-tag-writer", workspace];
  const stations = useQuery({ queryKey: key, queryFn: () => client.list(), refetchInterval: 3000 });
  const id = chosen || stations.data?.items[0]?.id || "";
  const station = stations.data?.items.find((s) => s.id === id);
  const mutation = useMutation({
    mutationFn: (type: "write" | "link" | "cancel") => type === "cancel" ? client.cancel(id) : client.queue(id, type, url),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: key }); },
  });
  const waiting = station?.command?.status === "waiting" && Date.parse(station.command.expires_at) > Date.now();
  return <section className="space-y-3 border-t border-line dark:border-slate-600 pt-4" aria-label="Write with a station">
    <h2 className="font-semibold">Use an NFC station</h2>
    <p className="text-sm text-muted">Write from any phone, including iPhone, or link a blank tag without writing it.</p>
    {stations.data?.items.length ? <>
      <label className="block">Station<select className="w-full rounded-md border border-line dark:border-slate-600 bg-transparent p-2 text-base" value={id} onChange={(e) => setChosen(e.target.value)}>{stations.data.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm disabled:opacity-50" disabled={mutation.isPending || waiting} onClick={() => mutation.mutate("write")}>Write to a tag</button>
        <button type="button" className="rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm disabled:opacity-50" disabled={mutation.isPending || waiting} onClick={() => mutation.mutate("link")}>Tap to link</button>
        {waiting && <button type="button" className="rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => mutation.mutate("cancel")}>Cancel tag request</button>}
      </div>
      {waiting && <p role="status">Tap the next tag at {station.name}. This request expires in five minutes.</p>}
      {!waiting && station?.command?.url === url && <p role={station.command.status === "failed" ? "alert" : "status"}>{station.command.message || "Tag request expired."}</p>}
    </> : stations.isPending ? <p role="status">Getting stations…</p> : <Link to="/scan/stations" className="text-accent underline">Add a scan station</Link>}
    {(stations.error || mutation.error) && <p role="alert" className="text-ember-600 dark:text-ember-400">{(stations.error || mutation.error)?.message}</p>}
  </section>;
}
