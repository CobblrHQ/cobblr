import { countOf } from "@cobblr/platform-contract/plural";
import { formatStockAmount } from "@cobblr/inventory/ui";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryError, SearchInput, usePageTitle, useRunAction } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { useEnabledModules } from "../lib/useEnabledModules";
import { resolveScannedThing, useScanTarget } from "../lib/scanTarget";
import { GlobalScanWedge } from "../components/GlobalScanWedge";
import { ScanOneSheet } from "../components/ScanOneSheet";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";

const button = "min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
export function StockStationPage() {
  const { activeSlug: slug } = useActiveOrg();
  const { station = "" } = useParams();
  usePageTitle("Stock station");
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [slot, setSlot] = useState("stock");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Stock is Inventory's: a workspace without it has none to load, and asking would be refused.
  const on = useEnabledModules(slug);
  const stockOff = on !== null && !on.has("inventory");
  const query = useQuery({ queryKey: ["workshop-stock", slug, station, q, offset], queryFn: () => api.listWorkshopStock(slug, { q, station, offset }), refetchInterval: 10_000, enabled: !!slug && !!on?.has("inventory") });
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 300_000 });
  const loaded = useQueries({ queries: (query.data?.loaded ?? []).map(l => ({ queryKey: ["stock-shape", slug, l.part_id], queryFn: () => api.workshopStock(slug, l.part_id) })) });
  // PRESS-ARGS: a loaded stock record supplies its collection's existing QR label target.
  const runAction = useRunAction();
  const accepts = (kind: string) => kind === "inventory:part" || kinds.data?.items.some(k => k.id === kind && k.module_name === "inventory") === true;
  const load = async (id: string, loadedNow = true, atSlot = slot) => {
    if (working.current) throw new Error("A stock confirmation is already being saved.");
    working.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const stock = await api.workshopStock(slug, id);
      await api.loadWorkshopStock(slug, id, { station, slot: atSlot, loaded: loadedNow });
      const result = `${stock.name} ${loadedNow ? `loaded in ${atSlot}` : "unloaded"}.`;
      setMessage(result);
      await qc.invalidateQueries({ queryKey: ["workshop-stock", slug] });
      await qc.invalidateQueries({ queryKey: ["stock-shape", slug] });
      return result;
    } catch (e) { setError(e instanceof Error ? e.message : "Stock could not be confirmed."); throw e; }
    finally { working.current = false; setBusy(false); }
  };
  // The station keeps every stock scan, ready or not: without a slot it says
  // so here, rather than the app-wide wedge opening the record and taking the
  // person off the station (review of #4963).
  useScanTarget({
    takes: accepts,
    take: thing => {
      if (!slot.trim()) return Promise.reject(new Error("Name the slot or colour first, then scan the label again."));
      return load(thing.id);
    },
  });
  const scanned = async (code: string) => {
    setScanning(false);
    try {
      const thing = await resolveScannedThing(slug, code);
      if (!thing || !accepts(thing.kind)) throw new Error("That label is not stock in this workspace.");
      await load(thing.id);
    } catch (e) { setError(e instanceof Error ? e.message : "The label could not be read."); }
  };
  const print = async (kind: string, id: string) => {
    try { await runAction({ actionId: "labels:print", entityKind: kind, entityId: id }); }
    catch (e) { setError(e instanceof Error ? e.message : "The label could not be printed."); }
  };
  return <main id={MAIN_ID} className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
    <SkipToContent /><GlobalScanWedge activeSlug={slug} />
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Stock station</h1><p className="text-muted break-words">{station}</p>{!stockOff && <Link to="/inventory" className="inline-flex min-h-11 items-center underline">Back to inventory</Link>}</header>
    {stockOff ? <p data-testid="stock-station-inventory-off" className="rounded border border-dashed border-line p-6 text-center text-muted">Stock is kept in Inventory, which is not on in this workspace. <Link to="/configuration/modules" className="text-accent hover:underline">Turn it on in Modules</Link></p> : <>
    <p>Scan the QR label on the sheet, roll, spool, bottle or tool you have loaded. Stock confirmation does not start a machine.</p>
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm flex-1 min-w-0">Slot or colour<input aria-label="Slot or colour" className="input min-h-12 w-full" required maxLength={80} value={slot} onChange={e => setSlot(e.target.value)} /></label><button className={button} disabled={busy || !slot.trim()} onClick={() => setScanning(true)}>Scan stock QR</button></div>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}{message && <p role="status">{message}</p>}
    <section className="space-y-3"><h2 className="text-sm font-mono uppercase tracking-wide">Loaded stock</h2>
      {!query.data?.loaded.length && <p className="text-muted">No stock confirmed at this station.</p>}
      {loaded.map((s, i) => { const at = query.data!.loaded[i]!; return <article key={at.part_id} className="rounded border border-line p-4 space-y-3">
        {s.isError && <QueryError what="Loaded stock could not be read." onRetry={() => void s.refetch()} />}
        <p>{at.slot}: <strong>{s.data?.name ?? "Loading stock"}</strong>{s.data && ` · ${formatStockAmount(s.data.remaining, s.data.unit)} remaining`}</p>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void load(at.part_id, false, at.slot).catch(() => {})}>Unload stock</button>{s.data && <><button className={button} onClick={() => void print(s.data!.kind, at.part_id)}>Print stock label</button><Link className={button} to={`/open/${encodeURIComponent(s.data.kind)}/${at.part_id}`}>Open stock record</Link></>}</div>
      </article>; })}
    </section>
    <section className="space-y-3"><h2 className="text-sm font-mono uppercase tracking-wide">Choose stock</h2><SearchInput value={q} onChange={value => { setQ(value); setOffset(0); }} placeholder="Find stock" />
      {query.isError && <QueryError what="Stock could not be loaded." onRetry={() => void query.refetch()} />}
      {query.data?.items.map(stock => <article key={stock.id} className="rounded border border-line p-3 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 break-words"><strong>{stock.name}</strong><p className="text-sm text-muted">{stock.shape} · {formatStockAmount(stock.remaining, stock.unit)} remaining{stock.low ? " · Low stock" : ""}</p></div><button className={button} disabled={busy || stock.remaining <= 0 || !slot.trim()} onClick={() => void load(stock.id).catch(() => {})}>Load {stock.name}</button></article>)}
      {query.data && <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 500))}>Previous stock</button><span className="text-sm">{query.data.total == null ? "Stock count unavailable" : countOf(query.data.total, "stock record")}</span><button className={button} disabled={query.data.total != null && offset + query.data.items.length >= query.data.total} onClick={() => setOffset(offset + 500)}>Next stock</button></div>}
    </section>
    </>}
    {scanning && <ScanOneSheet open title="Scan stock QR" hint="Scan the label on what is loaded in this slot." onCode={code => void scanned(code)} onClose={() => setScanning(false)} />}
  </main>;
}
