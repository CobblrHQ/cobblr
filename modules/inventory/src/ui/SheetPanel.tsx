import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError, QueryError } from "@cobblr/platform-web";
import { sheetSpec, type Rect } from "../sheet-area";
import { useInventory } from "./context";

// A free area edge is a sum with kerf and spacing, so 120 + 1.1 can read 121.10000000000001.
const mm = (n: number) => Math.round(n * 10) / 10;
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
export function SheetPanel({ id, metadata }: { id: string; metadata: Record<string, unknown> }) {
  const { api, orgSlug } = useInventory();
  const qc = useQueryClient();
  const key = ["inventory-sheet", orgSlug, id];
  const query = useQuery({ queryKey: [...key, JSON.stringify(metadata)], queryFn: () => api.sheet(id), enabled: !!sheetSpec(metadata) });
  const [mode, setMode] = useState<"cut" | "edit" | null>(null);
  const [rectangles, setRectangles] = useState<Rect[]>([]);
  const [revision, setRevision] = useState(0);
  const [kerf, setKerf] = useState<number | "">(0.1);
  const [verdict, setVerdict] = useState<"good" | "scrap">("good");
  const [spacing, setSpacing] = useState<number | "">(2);
  const save = useMutation({
    mutationFn: (undo: boolean) => api.changeSheet(id, undo ? { operation: "undo", revision: query.data!.revision } : { operation: mode!, revision, rectangles, verdict, kerf_mm: mode === "cut" ? Number(kerf) : 0, spacing_mm: mode === "cut" ? Number(spacing) : 0 }),
    onSuccess: () => { setMode(null); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["stock-shape", orgSlug, id] }); },
    onError: () => { void qc.invalidateQueries({ queryKey: key }); },
  });
  if (!sheetSpec(metadata)) return null;
  const view = query.data;
  return <section className="rounded-xl border border-line bg-surface p-4 space-y-3" data-testid="sheet-area">
    <h3 className="font-semibold">Sheet area</h3>
    {query.isError && <QueryError what="The record could not be loaded." onRetry={() => void query.refetch()} />}
    {view && <>
      <div className="flex flex-wrap items-center gap-2"><strong>About {Math.round(view.percent_left)}% left</strong>{view.offcut && <span className="rounded bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 px-2 py-1 text-sm">Offcut</span>}<span className="text-sm text-muted">{view.spec.width_mm} × {view.spec.height_mm} mm</span></div>
      <svg role="img" aria-label="Sheet drawing with used areas shaded and free areas outlined" viewBox={`0 0 ${view.spec.width_mm} ${view.spec.height_mm}`} className="block w-full max-h-72">
        <rect x={0} y={0} width={view.spec.width_mm} height={view.spec.height_mm} className="fill-slate-50 stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-700" strokeWidth={1} vectorEffect="non-scaling-stroke" data-testid="sheet-outline" />
        <g transform={`translate(0 ${view.spec.height_mm}) scale(1 -1)`}>
          <path d={view.used_outlines.map(points => `M ${points.map(p => `${p.x},${p.y}`).join(" L ")} Z`).join(" ")} fill="#94a3b8" fillRule="evenodd" />
          {view.free_rectangles.map((r, i) => <rect key={i} {...r} fill="none" stroke="#2563eb" strokeWidth={Math.max(view.spec.width_mm, view.spec.height_mm) / 250} />)}
        </g>
      </svg>
      <p className="text-sm text-muted">Grey is used. Blue outlines show room for another piece. Gaps under {view.spec.minimum_usable_mm} mm are left out.</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{view.free_rectangles.map((r, i) => <li key={i}>{mm(r.width)} × {mm(r.height)} mm at {mm(r.x)}, {mm(r.y)}</li>)}{!view.free_rectangles.length && <li>No usable area left.</li>}</ul>
      {!mode && <div className="flex flex-wrap gap-2">
        <button className={button} onClick={() => { setMode("cut"); setRevision(view.revision); setRectangles([{ x: 0, y: 0, width: Math.min(100, view.spec.width_mm), height: Math.min(100, view.spec.height_mm) }]); save.reset(); }}>Record a cut</button>
        <button className={button} onClick={() => { setMode("edit"); setRevision(view.revision); setRectangles(view.free_rectangles.map(r => ({ ...r }))); save.reset(); }}>Edit free area</button>
        <button className={button} disabled={!view.can_undo || save.isPending} onClick={() => save.mutate(true)}>Undo hand edit</button>
      </div>}
      {mode && <form className="space-y-3" onSubmit={e => { e.preventDefault(); save.mutate(false); }}>
        <p className="text-sm">{mode === "cut" ? "Enter each placed part's bounding box. Kerf and spacing are added around it." : "Keep only the rectangles still on the sheet. A hand edit can remove area, and Undo brings it back."} Measure X and Y from the lower left corner, in millimetres.</p>
        {rectangles.map((r, index) => <div key={index} className="rounded border border-line p-2 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{(["x", "y", "width", "height"] as const).map(field => <label key={field} className="text-sm">{field === "x" || field === "y" ? field.toUpperCase() : field[0]!.toUpperCase() + field.slice(1)} (mm)<input aria-label={`Area ${index + 1} ${field} (mm)`} className="input w-full min-h-11" type="number" step="any" min={field === "x" || field === "y" ? 0 : 0.001} required value={r[field]} onChange={e => setRectangles(old => old.map((p, i) => i === index ? { ...p, [field]: e.target.value === "" ? 0 : Number(e.target.value) } : p))} /></label>)}</div>
          <button type="button" className={button} onClick={() => setRectangles(old => old.filter((_, i) => i !== index))}>Remove area {index + 1}</button>
        </div>)}
        <button type="button" className={button} disabled={rectangles.length >= 128} onClick={() => setRectangles(old => [...old, { x: 0, y: 0, width: Math.min(20, view.spec.width_mm), height: Math.min(20, view.spec.height_mm) }])}>Add rectangle</button>
        {mode === "cut" && <label className="block text-sm">Result<select aria-label="Sheet cut result" className="input min-h-11 w-full" value={verdict} onChange={e => setVerdict(e.target.value as typeof verdict)}><option value="good">Came out good</option><option value="scrap">Scrap</option></select></label>}
        {mode === "cut" && <div className="grid grid-cols-2 gap-2">{([["Kerf (mm)", kerf, setKerf], ["Spacing (mm)", spacing, setSpacing]] as const).map(([label, value, set]) => <label key={label} className="text-sm">{label}<input className="input min-h-11 w-full" aria-label={label} type="number" min="0" max="1000" step="any" required value={value} onChange={e => set(e.target.value === "" ? "" : Number(e.target.value))} /></label>)}</div>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={save.isPending || mode === "cut" && !rectangles.length}>{mode === "cut" ? "Record cut" : "Save free area"}</button><button type="button" className={button} disabled={save.isPending} onClick={() => setMode(null)}>Cancel</button></div>
      </form>}
    </>}
    <MutationError mutation={save} />
  </section>;
}
