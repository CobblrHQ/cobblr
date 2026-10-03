import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { stationApi, stationKeys } from "../lib/scan-stations";
import type { StationMode } from "@cobblr/platform-contract/scan-station";
import QRCode from "qrcode";

const button = "rounded-md border border-line dark:border-slate-600 px-3 py-2 text-sm disabled:opacity-50";
const input = "w-full rounded-md border border-line dark:border-slate-600 bg-transparent p-2 text-base";
const modes: Array<{ value: StationMode; label: string }> = [{ value: "file", label: "File" }, { value: "print", label: "Print" }, { value: "navigate", label: "Open" }];

export function ScanStationsPage() {
  usePageTitle("Scan stations");
  const { activeSlug } = useActiveOrg();
  const { id = "", sessionId = "" } = useParams();
  const slug = activeSlug || "";
  const client = useMemo(() => stationApi(slug), [slug]);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<StationMode>("file");
  const [showCard, setShowCard] = useState(false);
  const devices = useQuery({ queryKey: stationKeys.devices(slug), queryFn: client.list, enabled: !!slug, refetchInterval: id ? 5000 : false });
  const device = useQuery({ queryKey: stationKeys.device(slug, id), queryFn: () => client.get(id), enabled: !!slug && !!id, refetchInterval: 5000 });
  const sessions = useInfiniteQuery({
    queryKey: stationKeys.sessions(slug, id), queryFn: ({ pageParam }) => client.sessions(id, pageParam),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.next_before || undefined,
    enabled: !!slug && !!id && !sessionId, refetchInterval: 5000,
  });
  const session = useQuery({ queryKey: stationKeys.session(slug, id, sessionId), queryFn: () => client.session(id, sessionId), enabled: !!slug && !!id && !!sessionId, refetchInterval: 5000 });
  const controls = useQuery({
    queryKey: [...stationKeys.device(slug, id), "controls"], enabled: !!id && showCard,
    queryFn: async () => Promise.all([
      ["File", "file"], ["Print", "print"], ["Open", "navigate"], ["Undo last", "undo"], ["End session", "end"],
    ].map(async ([label, value]) => ({ label, code: `cobblr:station:${value}`, image: await QRCode.toDataURL(`cobblr:station:${value}`, { width: 160, margin: 2 }) }))),
  });
  const change = useMutation({
    mutationFn: async (job: { type: "create" | "mode" | "end" | "undo" | "tag"; value?: StationMode; action?: string }) => {
      if (job.type === "create") return client.create(name, mode);
      if (job.type === "mode") return client.update(id, { mode: job.value });
      if (job.type === "end") return client.end(id);
      if (job.type === "tag") return client.controlTag(id, job.action!);
      return client.undo(id, sessionId, job.action);
    },
    onSuccess: async (_data, job) => { if (job.type === "create") setName(""); await qc.invalidateQueries({ queryKey: stationKeys.all(slug) }); },
  });
  const error = change.error || device.error || devices.error || session.error || sessions.error;
  const d = device.data;
  return <div className="max-w-3xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-display text-2xl font-extrabold page-title">{sessionId ? "Session review" : d?.name || "Scan stations"}</h1>
      <Link className="text-accent underline" to={id ? "/scan/stations" : "/scan"}>{id ? "All stations" : "Scan inbox"}</Link>
    </div>
    {error && <p role="alert" className="text-ember-600 dark:text-ember-400">{error.message}</p>}
    {!id ? <>
      <p className="text-muted">Scan a place, then things to put away. A station remembers the place for ten idle minutes. Review or undo what it did here.</p>
      <form className="space-y-3 rounded-lg border border-line dark:border-slate-600 p-4" onSubmit={(e) => { e.preventDefault(); change.mutate({ type: "create" }); }}>
        <label className="block">Station name<input className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
        <label className="block">What scans do<select className={input} value={mode} onChange={(e) => setMode(e.target.value as StationMode)}>{modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
        <button className={button} disabled={change.isPending} type="submit">Add station</button>
      </form>
      {devices.isPending && <p role="status">Getting stations…</p>}
      <ul className="space-y-3">{devices.data?.items.map((s) => <li key={s.id} className="rounded-lg border border-line dark:border-slate-600 p-4">
        <Link to={`/scan/stations/${s.id}`} className="font-semibold text-accent underline">{s.name}</Link>
        <p className="text-sm text-muted">{modes.find((m) => m.value === s.mode)?.label}{s.context ? ` into ${s.context.name}` : ""}</p>
      </li>)}</ul>
    </> : sessionId ? <>
      <Link className="text-accent underline" to={`/scan/stations/${id}`}>Back to station</Link>
      {session.data ? <>
        <p className="text-sm text-muted">{session.data.device_name} · {new Date(session.data.started_at).toLocaleString()} · {session.data.ended_at ? "Ended" : "Active"}</p>
        <button className={button} disabled={change.isPending} onClick={() => change.mutate({ type: "undo" })}>Undo whole session</button>
        <ol className="space-y-3">{session.data.actions.map((a) => <li key={a.id} className="rounded-lg border border-line dark:border-slate-600 p-4 space-y-2">
          <p>{a.message}</p>
          {a.before && <p className="text-sm text-muted">From {a.before.container?.name || "no place"} to {a.after?.container?.name || "no place"}</p>}
          <p className="text-sm text-muted">{new Date(a.at).toLocaleTimeString()} · {a.status === "undone" ? "Undone" : a.status === "refused" ? "Refused" : a.status === "pending" || a.status === "undo_pending" ? "Waiting for the station to finish" : "Done"}</p>
          {a.undo_error && <p role="alert">{a.undo_error}</p>}
          <div className="flex flex-wrap gap-3">
            {a.thing?.path && <Link to={a.thing.path} className="text-accent underline">{a.type === "inbox" ? "Name in the inbox" : "Open record"}</Link>}
            {a.status === "done" && ["file", "inbox", "container", "open"].includes(a.type) && <button className={button} disabled={change.isPending} onClick={() => change.mutate({ type: "undo", action: a.id })}>Undo</button>}
          </div>
        </li>)}</ol>
      </> : <p role="status">Getting session…</p>}
    </> : d ? <>
      <p>Next things go into <strong>{d.context?.name || "a place you scan"}</strong>.</p>
      <label className="block">What scans do<select className={input} value={d.mode} disabled={change.isPending} onChange={(e) => change.mutate({ type: "mode", value: e.target.value as StationMode })}>{modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
      <p className="text-sm text-muted">Scan a holder once to put it away. Scan it twice in a row to put things inside it. Scan any place to leave the holder.</p>
      <label className="block">Station ID<input className={input} readOnly value={d.id} /></label>
      <p className="text-sm text-muted">Copy this ID into the relay’s existing setup portal. Use an API token for your account and this workspace. The same station works with a barcode reader or an NFC reader.</p>
      <div className="flex flex-wrap gap-3">
        <button className={button} disabled={!d.session_id || change.isPending} onClick={() => change.mutate({ type: "end" })}>End session</button>
        <button className={button} onClick={() => setShowCard((v) => !v)}>{showCard ? "Hide controls" : "Printable controls"}</button>
      </div>
      {showCard && <section aria-label="Station controls" className="space-y-3 rounded-lg border border-line dark:border-slate-600 p-4">
        <h2 className="text-sm font-mono uppercase tracking-widest text-accent">Station controls</h2>
        <p className="text-sm text-muted">Use the station button to undo with a short press or end with a long press. A barcode reader can scan these controls.</p>
        <div className="flex flex-wrap gap-4">{controls.data?.map((c) => <div key={c.label} className="text-center"><img src={c.image} alt={`${c.label} control QR`} width={160} height={160} /><p>{c.label}</p><button className={button} disabled={change.isPending} onClick={() => change.mutate({ type: "tag", action: c.code })}>Write {c.label} to a tag</button></div>)}</div>
        {d.command?.status === "waiting" && <p role="status">Tap the next tag at this station.</p>}
        {d.command?.message && <p role={d.command.status === "failed" ? "alert" : "status"}>{d.command.message}</p>}
        <button className={button} onClick={() => window.print()}>Print controls</button>
      </section>}
      <h2 className="text-sm font-mono uppercase tracking-widest text-accent">Sessions</h2>
      <ul className="space-y-3">{sessions.data?.pages.flatMap((page) => page.items).map((s) => <li key={s.id}>
        <Link to={`/scan/stations/${id}/sessions/${s.id}`} className="text-accent underline">{new Date(s.started_at).toLocaleString()} · {s.count} actions · {s.ended_at ? "Review" : "Active"}</Link>
      </li>)}</ul>
      {sessions.hasNextPage && <button className={button} disabled={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()}>Older sessions</button>}
    </> : <p role="status">Getting station…</p>}
  </div>;
}
