import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError, QueryError } from "@cobblr/platform-web";
import { StockConfig, formatStockAmount, stockUnitLabel, type StockShape } from "../stock-shapes";
import type { StockDetail } from "./api";
import { useInventory } from "./context";
import { AddToListButton } from "./AddToListButton";
import { randomId } from "@cobblr/platform-contract";

const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const shapes: Array<{ value: StockShape; label: string }> = [{ value: "sheet", label: "Sheet" }, { value: "roll", label: "Roll" }, { value: "spool", label: "Spool" }, { value: "liquid", label: "Liquid" }, { value: "wearing-tool", label: "Wearing tool" }, { value: "count", label: "Count" }];
const shown = (n: number) => Number(n.toFixed(3)).toLocaleString();
export function StockPanel({ id, hideThreshold = false }: { id: string; hideThreshold?: boolean }) {
  const { api, orgSlug, entityKind } = useInventory();
  const qc = useQueryClient();
  const key = ["stock-shape", orgSlug, id];
  const query = useQuery({ queryKey: key, queryFn: () => api.stockShape(id) });
  const [editing, setEditing] = useState(false);
  const [using, setUsing] = useState(false);
  const [station, setStation] = useState("");
  const reload = () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["inventory-sheet", orgSlug, id] }); void qc.invalidateQueries({ queryKey: ["inventory-parts"] }); void qc.invalidateQueries({ queryKey: ["inventory-part"] }); };
  const load = useMutation({ mutationFn: () => api.loadStock(id, { station: query.data?.loaded?.station ?? station, loaded: !query.data?.loaded }), onSuccess: reload });
  const view = query.data;
  return <section className="rounded-xl border border-line bg-surface p-4 space-y-3" data-testid="stock-shape">
    <h3 className="font-semibold">Workshop stock</h3>
    {query.isError && <QueryError what="Stock could not be loaded." onRetry={() => void query.refetch()} />}
    {view && <>
      <div className="flex flex-wrap items-center gap-2"><span>{shapes.find(s => s.value === view.shape)?.label}</span><strong>{formatStockAmount(view.remaining, view.unit)} remaining</strong>{view.low && <span className="text-amber-700 dark:text-amber-300">Low stock</span>}{view.low && <AddToListButton kind={entityKind} id={id} />}</div>
      {view.shape === "roll" && view.config.shape === "roll" && <p className="text-sm text-muted">{view.config.width_mm} mm wide. Each job uses {view.config.waste} m of waste unless you measure it.</p>}
      {view.config.shape === "wearing-tool" && <p className="text-sm text-muted">{shown(view.used)} of {formatStockAmount(view.config.limit, view.unit)} used. Replacement follows your maintenance schedule.</p>}
      {!hideThreshold && <p className="text-sm text-muted">Low-stock threshold: {formatStockAmount(view.low_threshold, view.unit)}</p>}
      {!editing && !using && <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setEditing(true)}>Set stock shape</button><button className={button} disabled={view.shape === "sheet"} onClick={() => setUsing(true)}>Record stock use</button></div>}
      {view.shape === "sheet" && <p className="text-sm text-muted">Record a cut or edit what remains in Sheet area below.</p>}
      {editing && <StockForm view={view} hideThreshold={hideThreshold} onDone={() => { setEditing(false); reload(); }} onCancel={() => setEditing(false)} />}
      {using && <UseForm view={view} onDone={() => { setUsing(false); reload(); }} onCancel={() => setUsing(false)} />}
      <div className="space-y-2 border-t border-line pt-3">
        {view.loaded ? <><p className="text-sm">Loaded at {view.loaded.station}, {view.loaded.slot}.</p><div className="flex flex-wrap gap-2"><Link className={button} to={`/station/stock/${encodeURIComponent(view.loaded.station)}`}>Open stock station</Link><button className={button} disabled={load.isPending} onClick={() => load.mutate()}>Unload stock</button></div></>
          : <form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); load.mutate(); }}><label className="text-sm flex-1 min-w-0">Station name<input aria-label="Station name" className="input min-h-11 w-full" value={station} required maxLength={160} onChange={e => setStation(e.target.value)} placeholder="Cutting bench" /></label><button className={button} disabled={load.isPending || !station.trim() || view.remaining <= 0}>Confirm loaded stock</button></form>}
        <p className="text-sm text-muted">Use this record's QR label at the station to confirm what you have loaded.</p>
        <MutationError mutation={load} />
      </div>
      {view.uses.length > 0 && <details><summary className="min-h-11 cursor-pointer flex items-center text-sm">Recent stock use</summary><ul className="space-y-2 text-sm">{view.uses.map(u => <li key={u.id} className="break-words">{u.source}: {formatStockAmount(Number(u.amount), u.unit)} ({u.verdict})</li>)}</ul></details>}
    </>}
  </section>;
}

function StockForm({ view, hideThreshold, onDone, onCancel }: { view: StockDetail; hideThreshold: boolean; onDone: () => void; onCancel: () => void }) {
  const { api } = useInventory();
  const [revision] = useState(view.revision);
  const [shape, setShape] = useState(view.shape);
  const [unit, setUnit] = useState(view.config.shape === "sheet" ? "each" : view.config.unit);
  const [remaining, setRemaining] = useState(String(view.remaining));
  const [threshold, setThreshold] = useState(String(view.low_threshold));
  const [width, setWidth] = useState(view.config.shape === "roll" ? String(view.config.width_mm) : "600");
  const [waste, setWaste] = useState(view.config.shape === "roll" ? String(view.config.waste) : "0");
  const [grams, setGrams] = useState(view.config.shape === "spool" ? String(view.config.grams_per_m ?? "") : "");
  const [limit, setLimit] = useState(view.config.shape === "wearing-tool" ? String(view.config.limit) : "10");
  const [used, setUsed] = useState(String(view.used));
  const [material, setMaterial] = useState(view.sheet?.spec.material ?? "");
  const [thickness, setThickness] = useState(String(view.sheet?.spec.thickness_mm ?? 3));
  const [sheetWidth, setSheetWidth] = useState(String(view.sheet?.spec.width_mm ?? 200));
  const [height, setHeight] = useState(String(view.sheet?.spec.height_mm ?? 200));
  const [warning, setWarning] = useState("");
  const save = useMutation({ mutationFn: async () => {
    const config = StockConfig.parse({ shape, unit: shape === "roll" ? "m" : shape === "liquid" ? "ml" : shape === "count" ? "each" : unit,
      low_threshold: Number(threshold), width_mm: Number(width), waste: Number(waste), grams_per_m: grams ? Number(grams) : undefined, limit: Number(limit) });
    return api.configureStock(view.id, { config, revision, ...(shape === "wearing-tool" ? { used: Number(used) } : shape === "sheet" ? { sheet: { material, thickness_mm: Number(thickness), width_mm: Number(sheetWidth), height_mm: Number(height) } } : { remaining: Number(remaining) }) });
  }, onSuccess: result => { if (result.warning) setWarning(result.warning); else onDone(); } });
  const numeric = (label: string, value: string, setDraft: (v: string) => void, optional = false) => <label className="text-sm" key={label}>{label}<input aria-label={label} type="number" min="0" step="any" required={!optional} className="input min-h-11 w-full" value={value} onChange={e => setDraft(e.target.value)} /></label>;
  const actualUnit = stockUnitLabel(shape === "sheet" ? "mm²" : shape === "roll" ? "m" : shape === "liquid" ? "ml" : shape === "count" ? "each" : unit);
  return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="text-sm">Shape<select aria-label="Stock shape" className="input min-h-11 w-full" value={shape} onChange={e => { const next = e.target.value as StockShape; setShape(next); setUnit(next === "spool" ? "g" : next === "wearing-tool" ? "h" : "each"); }}>{shapes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
      {(shape === "spool" || shape === "wearing-tool") && <label className="text-sm">Unit<select aria-label="Stock unit" className="input min-h-11 w-full" value={unit} onChange={e => setUnit(e.target.value as typeof unit)}>{(shape === "spool" ? ["g", "m"] : ["h", "uses", "m"]).map(u => <option key={u} value={u}>{stockUnitLabel(u)}</option>)}</select></label>}
      {shape !== "sheet" && shape !== "wearing-tool" && numeric(`Remaining (${actualUnit})`, remaining, setRemaining)}
      {!hideThreshold && numeric(`Low-stock threshold (${actualUnit})`, threshold, setThreshold)}
      {shape === "roll" && <>{numeric("Roll width (mm)", width, setWidth)}{numeric("Waste per job (m)", waste, setWaste)}</>}
      {shape === "spool" && numeric("Grams per metre (optional)", grams, setGrams, true)}
      {shape === "wearing-tool" && <>{numeric(`Replacement threshold (${actualUnit})`, limit, setLimit)}{numeric(`Already used (${actualUnit})`, used, setUsed)}</>}
      {shape === "sheet" && <><label className="text-sm">Material<input aria-label="Sheet material" className="input min-h-11 w-full" required value={material} onChange={e => setMaterial(e.target.value)} /></label>{numeric("Thickness (mm)", thickness, setThickness)}{numeric("Original width (mm)", sheetWidth, setSheetWidth)}{numeric("Original height (mm)", height, setHeight)}</>}
    </div>
    <MutationError mutation={save} />
    {warning && <p role="status" className="text-sm">{warning}</p>}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={save.isPending}>Save stock shape</button><button type="button" className={button} disabled={save.isPending} onClick={warning ? onDone : onCancel}>{warning ? "Done" : "Cancel"}</button></div>
  </form>;
}
function UseForm({ view, onDone, onCancel }: { view: StockDetail; onDone: () => void; onCancel: () => void }) {
  const { api } = useInventory();
  const [revision] = useState(view.revision);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(view.unit);
  const [source, setSource] = useState<string>(() => randomId());
  const [verdict, setVerdict] = useState<"good" | "scrap">("good");
  const [waste, setWaste] = useState("");
  const [warning, setWarning] = useState("");
  const save = useMutation({ mutationFn: () => api.consumeStock(view.id, { revision, source, verdict, amount: Number(amount), unit, ...(view.shape === "roll" && waste.trim() ? { waste: Number(waste) } : {}) }), onSuccess: result => { if (result.warning) setWarning(result.warning); else onDone(); } });
  const units = view.shape === "spool" ? ["g", "kg", "m", "mm"] : view.unit === "h" ? ["h", "min"] : view.unit === "m" ? ["m", "mm", "cm"] : view.unit === "ml" ? ["ml", "l"] : [view.unit];
  return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="text-sm">Amount used<input aria-label="Amount used" className="input min-h-11 w-full" type="number" min="0.000001" step="any" required value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <label className="text-sm">Unit<select aria-label="Use unit" className="input min-h-11 w-full" value={unit} onChange={e => setUnit(e.target.value)}>{units.map(u => <option key={u} value={u}>{stockUnitLabel(u)}</option>)}</select></label>
      {view.config.shape === "roll" && <label className="text-sm">Measured waste (m, optional)<input aria-label="Measured waste (m, optional)" className="input min-h-11 w-full" type="number" min="0" step="any" placeholder={String(view.config.waste)} value={waste} onChange={e => setWaste(e.target.value)} /><span className="text-muted">Leave blank to use the waste allowance.</span></label>}
      <label className="text-sm">Job or use reference<input aria-label="Job or use reference" className="input min-h-11 w-full" required maxLength={160} value={source} onChange={e => setSource(e.target.value)} /></label>
      <label className="text-sm">Result<select aria-label="Job result" className="input min-h-11 w-full" value={verdict} onChange={e => setVerdict(e.target.value as typeof verdict)}><option value="good">Came out good</option><option value="scrap">Scrap</option></select></label>
    </div><p className="text-sm text-muted">Both results record what was used. Give each stock draw its own reference.</p>
    <MutationError mutation={save} />{warning && <p role="status" className="text-sm">{warning}</p>}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={save.isPending || !!warning}>Save stock use</button><button type="button" className={button} disabled={save.isPending} onClick={warning ? onDone : onCancel}>{warning ? "Done" : "Cancel"}</button></div>
  </form>;
}
