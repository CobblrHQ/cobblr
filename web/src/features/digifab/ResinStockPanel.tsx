import { SearchInput } from "@cobblr/platform-web";
import { formatStockAmount } from "@cobblr/inventory/ui";
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { resolveScannedThing, useScanTarget } from "../../lib/scanTarget";
import { ScanOneSheet } from "../../components/ScanOneSheet";
import { GlobalScanWedge } from "../../components/GlobalScanWedge";
import { api, ApiError, type MachineStationView } from "../../lib/api";
const button = "min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
const slots = [
  { id: "bottle", label: "Resin bottle", shape: "liquid" as const, unit: "ml" },
  { id: "vat", label: "Resin in the vat", shape: "liquid" as const, unit: "ml" },
  { id: "film-layers", label: "Film, counted by layers", shape: "wearing-tool" as const, unit: "uses" },
  { id: "film-prints", label: "Film, counted by prints", shape: "wearing-tool" as const, unit: "uses" },
  { id: "lcd", label: "LCD exposure hours", shape: "wearing-tool" as const, unit: "h" },
];
export function ResinStockPanel({ slug, resin, onChanged }: { slug: string; resin: NonNullable<MachineStationView["resin"]>; onChanged: () => Promise<unknown> }) {
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [slot, setSlot] = useState("bottle");
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState("");
  const chosenSlot = slots.find(item => item.id === slot)!;
  const choices = useInfiniteQuery({ queryKey: ["resin-stock-choices", slug, chosenSlot.shape, search], initialPageParam: 0, queryFn: ({ pageParam }) => api.listWorkshopStock(slug, { shape: chosenSlot.shape, q: search, limit: 100, offset: pageParam }), getNextPageParam: (last, _pages, offset) => last.complete ? undefined : offset + 100 });
  const load = useMutation({ mutationFn: async ({ id, slot, loaded }: { id: string; slot: string; loaded: boolean }) => {
    if (loaded && slot.startsWith("film-")) {
      for (const previous of resin.loaded.filter(item => item.slot?.startsWith("film-") && item.slot !== slot)) await api.loadWorkshopStock(slug, previous.id, { station: resin.station, slot: previous.slot!, loaded: false });
    }
    await api.loadWorkshopStock(slug, id, { station: resin.station, slot, loaded });
    setPick(""); await onChanged(); await choices.refetch();
  } });
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 300_000 });
  const accepts = (kind: string) => kind === "inventory:part" || kinds.data?.items.some(item => item.id === kind && item.module_name === "inventory") === true;
  const scannedStock = async (id: string) => {
    if (load.isPending) throw new Error("A stock confirmation is already being saved.");
    const stock = await api.workshopStock(slug, id);
    if (stock.shape !== chosenSlot.shape || stock.unit !== chosenSlot.unit || stock.remaining <= 0) throw new Error(`Choose ${chosenSlot.shape === "liquid" ? "liquid stock in ml" : `a wearing tool in ${chosenSlot.unit}`} for this slot.`);
    await load.mutateAsync({ id, slot, loaded: true });
    return `${stock.name} loaded in ${chosenSlot.label.toLowerCase()}.`;
  };
  useScanTarget({ takes: accepts, take: thing => scannedStock(thing.id) });
  const scanned = async (code: string) => {
    setScanning(false); setScanError("");
    try {
      const thing = await resolveScannedThing(slug, code);
      if (!thing || !accepts(thing.kind)) throw new Error("That label is not stock in this workspace.");
      await scannedStock(thing.id);
    } catch (e) { setScanError(e instanceof Error ? e.message : "The label could not be read."); }
  };
  const options = choices.data?.pages.flatMap(page => page.items).filter(item => item.unit === chosenSlot.unit && item.remaining > 0) ?? [];
  return <section className="rounded border border-line p-4 space-y-4" aria-label="Loaded resin and wearing tools">
    <h2 className="text-xl font-semibold font-mono uppercase tracking-wide">Loaded resin and tools</h2>
    <p>The bottle and vat use liquid stock in ml. Film and LCD records use their own replacement limits. Load one film record, counted by layers or prints.</p>
    <GlobalScanWedge activeSlug={slug} />
    {resin.loaded.length ? <ul className="space-y-3">{resin.loaded.map(item => <li key={item.slot} className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 break-words"><strong>{slots.find(slot => slot.id === item.slot)?.label}: {item.name}</strong><p>{formatStockAmount(item.remaining, item.unit)} remaining{item.shape === "wearing-tool" ? ` · ${formatStockAmount(item.used, item.unit)} used` : ""}</p>{item.maintenance_due && <p role="status" className="text-amber-700 dark:text-amber-400">Replacement is due. Check Maintenance.</p>}{item.low && <p role="status" className="text-amber-700 dark:text-amber-400">This stock is low.</p>}</div><button className={button} disabled={load.isPending} onClick={() => load.mutate({ id: item.id, slot: item.slot!, loaded: false })}>Unload</button></li>)}</ul> : <p>No resin bottle is loaded.</p>}
    <details><summary className="cursor-pointer min-h-12 flex items-center">Load a bottle, vat or wearing tool</summary><div className="space-y-3 py-3">
      <label className="block">Station slot<select className="w-full rounded border border-line bg-surface p-3" value={slot} onChange={e => { setSlot(e.target.value); setPick(""); }}><option value="bottle">Resin bottle</option>{slots.slice(1).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button className={button} disabled={load.isPending} onClick={() => setScanning(true)}>Scan stock QR</button>
      <label className="block">Find stock<SearchInput value={search} onChange={value => { setSearch(value); setPick(""); }} placeholder="Find stock" /></label>
      <label className="block">Stock record<select className="w-full rounded border border-line bg-surface p-3" value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose stock</option>{options.map(item => <option key={item.id} value={item.id}>{item.name} · {formatStockAmount(item.remaining, item.unit)}</option>)}</select></label>
      {choices.hasNextPage && <button className={button} disabled={choices.isFetchingNextPage} onClick={() => void choices.fetchNextPage()}>More stock</button>}
      {choices.data && !options.length && <p>No matching stock is available. Set its liquid or wearing tool shape on its Inventory record first.</p>}
      <button className={button} disabled={load.isPending || !pick} onClick={() => load.mutate({ id: pick, slot, loaded: true })}>Confirm this stock is loaded</button>
    </div></details>
    {scanning && <ScanOneSheet open title="Scan stock QR" hint={`Scan the label for ${chosenSlot.label.toLowerCase()}.`} onCode={code => void scanned(code)} onClose={() => setScanning(false)} />}
    {scanError && <p role="alert">{scanError}</p>}
    {(load.error || choices.error) && <p role="alert">{(load.error || choices.error) instanceof ApiError ? (load.error || choices.error)!.message : "The stock could not be read or loaded. Check Inventory."}</p>}
  </section>;
}
