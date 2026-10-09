import { jobDisplayName } from "../features/digifab/jobDisplayName";
import { DirectLaserControls } from "../features/digifab/DirectLaserControls";
import { laserLayerLabel } from "../lib/laser-layer-label";
import { countOf } from "@cobblr/platform-contract/plural";
import { fabricationMachineName, fabricationBridgeName, laserState, fabricationBridgeLine } from "../lib/fabrication-display";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useConfirm, usePageTitle, useRunAction, NumberField } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
import { LaserDrawing } from "../features/digifab/LaserLayout";
import { api, type MaterialDispatch } from "../lib/api";
const button = "inline-flex min-h-11 items-center justify-center rounded border border-line px-4 py-2 disabled:opacity-50";
const control = "block min-h-11 w-full rounded border border-line bg-surface px-3 py-2";
const panel = "min-w-0 rounded-lg border border-line bg-surface p-4 space-y-3";
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export function FloorManagerPage({ screen = false }: { screen?: boolean }) {
 const { activeSlug: slug } = useActiveOrg();
 usePageTitle("Floor manager");
 const confirm = useConfirm();
 // PRESS-ARGS: The drawing form and saved batch supply all dispatch inputs before confirmation.
 const runAction = useRunAction();
 const floor = useQuery({ queryKey: ["fabrication-floor", slug], queryFn: () => api.getFabricationFloor(slug), refetchInterval: 10000 });
 const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug), refetchInterval: 10000 });
 const bridges = useQuery({ queryKey: ["edge-bridges", slug], queryFn: () => api.listEdgeBridges(slug) });
 const [drawing, setDrawing] = useState(""); const [material, setMaterial] = useState(""); const [quantity, setQuantity] = useState(1);
 const [spacing, setSpacing] = useState(1); const [kerf, setKerf] = useState(0); const [rotate, setRotate] = useState(true); const [units, setUnits] = useState("mm");
 const [operations, setOperations] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
 const design = useQuery({ queryKey: ["laser-design", slug, drawing, units], queryFn: () => api.laserDesign(slug, drawing, units), enabled: !!drawing });
 const data = floor.data;
 const layers = [...new Set(design.data?.paths.map(p => p.layer) ?? [])];
 const selectedMaterial = data?.laser_materials.find(m => `${m.material}:${m.thickness_mm}` === material);
 const dispatch = async (operation: "plan" | "queue" | "cancel", args: Record<string, unknown>) => {
  if (busy) return;
  if (operation === "queue" && !await confirm({ title: "Queue these sheet jobs?", message: "The compiled layouts will be verified with each laser driver. Each sheet still needs approval and Start at its machine station.", confirmLabel: "Verify and queue" })) return;
  setBusy(true); setError(""); setNotice("");
  try {
   const out = await runAction({ actionId: "digifab:dispatch-material", args: { operation, ...args } });
   const result = out.result as { batch: MaterialDispatch; blocked?: string };
   setNotice(result.blocked || (operation === "queue" ? `${countOf(result.batch.request.quantity, "part")} queued. Open the machine stations to load and approve each sheet.` : operation === "cancel" ? "Batch withdrawn." : "Review every sheet before queueing."));
   await floor.refetch(); await fleet.refetch();
  } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
 };
 const content = <div className={`space-y-6 ${screen ? "p-4 sm:p-6 text-lg" : "p-4 sm:p-6"}`} data-testid="floor-manager">
  <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-semibold">Floor manager</h1><p className="text-muted">All machines, their queues and what needs a person.</p></div><div className="flex flex-wrap gap-3"><Link className={button} to={screen ? "/digifab/manager" : "/station/floor"}>{screen ? "Exit shared screen" : "Open shared screen"}</Link>{!screen && <Link className={button} to="/digifab">Fleet and setup</Link>}</div></header>
  {(error || floor.error || fleet.error) && <p role="alert" className={`${panel} border-red-500 break-words`}>{error || errorText(floor.error || fleet.error)}</p>}
  {notice && <p role="status" className={`${panel} break-words`}>{notice}</p>}
  {!data && !floor.error && <p>Loading the floor…</p>}
  {fleet.data && <section aria-label="All machine queues" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{fleet.data.connections.map(c => c.error && !c.devices.length ? <article key={c.connection_id} className={panel}><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">{c.label}</h2><p role="alert">Connection unavailable: {c.error}</p></article> : c.devices.map(d => {
   const laser = !!d.laser_backend || d.lightburn_readiness != null || data?.laser_devices.some(p => p.connection_id === c.connection_id && p.device_id === d.id);
   const queue = data?.jobs.filter(j => j.connection_id === c.connection_id && j.target_device === d.id && j.status === "queued") ?? [];
   const current = d.active_job;
   const eta = current?.eta_sec != null ? Math.ceil(current.eta_sec / 60) : d.live?.remaining_min;
   const station = laser ? `/station/machine/${c.connection_id}/${encodeURIComponent(d.id)}` : d.linked_machine_id ? `/station/printer/${d.linked_machine_id}` : null;
   return <article key={`${c.connection_id}:${d.id}`} className={panel} data-testid="floor-machine"><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide break-words">{fabricationMachineName(c, d)}</h2>{(() => { const line = fabricationBridgeLine(fabricationMachineName(c, d), fabricationBridgeName(c, bridges.data?.bridges ?? [])); return line ? <p className="text-muted break-words">{line}</p> : null; })()}<p className="text-muted">{laser ? "Laser" : "Printer"} · {laser ? laserState(d.state) : d.state}{!d.enabled ? " · Disabled" : ""}</p>{c.error && <p role="alert" className="break-words">Connection unavailable: {c.error}</p>}{c.stale && <p className="text-muted">Last known state. Refreshing the connection.</p>}
    <p className="font-semibold text-xl">{d.needs_attention ? laser ? "Take pieces out" : "Clear the bed" : queue.length && laser && !current ? "Waiting for sheet approval" : d.stage || ""}</p>
    <p className="break-words">Current: {jobDisplayName(current) || (d.klass === "printing" ? "Running outside Cobblr" : "None")}</p>{(current || d.live) && <p>{current?.progress != null ? `${Math.round(current.progress * 100)}% · ` : ""}{eta != null ? `About ${countOf(Math.ceil(eta), "minute")} left` : "ETA unavailable"}</p>}
    <p className="break-words">Next: {jobDisplayName(queue[0]) || "None assigned"}</p>{!!queue.length && <ol className="space-y-2" aria-label={`Queue for ${d.name}`}>{queue.map(j => <li key={j.id} className="break-words">{jobDisplayName(j)}{j.blocked && <p>{j.blocked}</p>}</li>)}</ol>}
    {d.laser_backend && <DirectLaserControls slug={slug} connectionId={c.connection_id} deviceId={d.id} status={current?.status} state={d.state} onAccepted={() => void floor.refetch()} />}
    {station && <Link className={button} to={station}>Open {laser ? "laser" : "printer"} station</Link>}
   </article>;
  }))}{fleet.data.summary.devices === 0 && <p>No machines connected. Add them in Fleet and setup.</p>}</section>}
  {data && <>
   {data.jobs.some(j => j.target_pool && !j.connection_id) && <section className={panel}><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Waiting for placement</h2>{data.jobs.filter(j => j.target_pool && !j.connection_id).map(j => <div key={j.id} className="break-words"><p className="font-semibold">{jobDisplayName(j)} · {data.pools.find(p => p.id === j.target_pool)?.name || "Pool"}</p><p>{j.blocked || "Waiting for an available machine"}</p></div>)}</section>}
   <section className="space-y-3"><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Material on hand</h2>{!data.stock_complete && <p role="alert">The stock list is incomplete. Choose sheets explicitly in Prepare laser batch.</p>}<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{data.stock.map(m => <article className={panel} key={`${m.material}:${m.thickness_mm}`}><h3 className="text-xl font-semibold font-mono uppercase tracking-wide">{m.thickness_mm != null ? `${m.thickness_mm} mm ` : ""}{m.material}</h3><p>{m.thickness_mm != null ? `${m.sheets} ${m.sheets === 1 ? "sheet" : "sheets"}, including ${m.offcuts} ${m.offcuts === 1 ? "offcut" : "offcuts"}` : `${m.spools} ${m.spools === 1 ? "spool" : "spools"}`}</p><p>{m.thickness_mm != null ? `${Math.round(m.free_mm2 / 100)} cm² free area` : `${Math.round(m.grams)} g remaining`}</p></article>)}</div>{!data.stock.length && <p>No tagged sheets or filament spools in stock.</p>}</section>
   {!!data.reorders.length && <section className={panel}><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Material to restock</h2><p>These shortages join the existing daily low-stock digest. Load material already on hand at its machine station.</p>{data.reorders.map(r => <p key={r.key} className="break-words">{r.text}</p>)}<Link to="/inventory" className={button}>Open stock</Link></section>}
   {!screen && <section className={panel}><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Dispatch by material</h2><p>Spread raw drawing copies across available lasers with matching profiles. Review the layouts, then queue. Start stays at each machine station.</p><form className="space-y-4" onSubmit={e => { e.preventDefault(); if (selectedMaterial) void dispatch("plan", { request: { library_id: drawing, quantity, ...selectedMaterial, operations: Object.fromEntries(layers.map(l => [l, operations[l] || "cut"])), spacing_mm: spacing, kerf_mm: kerf, rotate, dxf_units: units } }); }}>
    <div className="grid gap-4 md:grid-cols-3"><label>Drawing<select className={control} required value={drawing} disabled={busy} onChange={e => { setDrawing(e.target.value); setOperations({}); }}><option value="">Choose a stored SVG or DXF</option>{data.drawings.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label>Material<select className={control} required disabled={busy} value={material} onChange={e => setMaterial(e.target.value)}><option value="">Choose a laser material</option>{data.laser_materials.map(m => <option key={`${m.material}:${m.thickness_mm}`} value={`${m.material}:${m.thickness_mm}`}>{m.thickness_mm} mm {m.material}</option>)}</select></label><label>Quantity<NumberField className={control} required min={1} max={10000} value={quantity} disabled={busy} onChange={(n) => setQuantity(n)} /></label></div>
    {drawing && data.drawings.find(d => d.id === drawing)?.kind === "dxf" && <label>Units when DXF has no unit saved<select className={control} value={units} disabled={busy} onChange={e => setUnits(e.target.value)}><option value="mm">Millimetres</option><option value="in">Inches</option></select></label>}
    {design.error && <p role="alert">{errorText(design.error)}</p>}
    <div className="grid gap-4 md:grid-cols-3">{layers.map(l => <label key={l}>Operation for {laserLayerLabel(l)}<select className={control} value={operations[l] || "cut"} disabled={busy} onChange={e => setOperations({ ...operations, [l]: e.target.value })}>{["cut", "score", "engrave"].map(o => <option key={o}>{o}</option>)}</select></label>)}<label>Spacing (mm)<NumberField className={control} min={0} max={100} value={spacing} disabled={busy} onChange={(n) => setSpacing(n)} /></label><label>Kerf (mm)<NumberField className={control} min={0} max={100} value={kerf} disabled={busy} onChange={(n) => setKerf(n)} /></label></div><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={rotate} disabled={busy} onChange={e => setRotate(e.target.checked)} />Allow quarter turns</label><button className={button} disabled={busy || !layers.length || !selectedMaterial} type="submit">Preview dispatch</button>
   </form></section>}
   {data.batches.map(b => <section className={panel} key={b.id} data-testid="material-batch"><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">{countOf(b.request.quantity, "part")} · {b.request.thickness_mm} mm {b.request.material}</h2><p>{b.status === "planned" ? "Ready for layout review" : b.status}</p>{b.error && <p role="alert" className="break-words">{b.error}</p>}{!screen && <><div className="grid gap-4 md:grid-cols-2">{data.layouts.filter(p => b.plan_ids.includes(p.id)).map(p => <div className="min-w-0 space-y-3" key={p.id}><h3 className="text-xl font-semibold font-mono uppercase tracking-wide">{countOf(p.plan.quantity, "part")} · {fleet.data?.connections.find(c => c.connection_id === p.connection_id)?.devices.find(d => d.id === p.remote_device_id)?.linked_machine?.name || p.remote_device_id}</h3><p>About {countOf(Math.ceil(p.plan.estimated_sec / 60), "minute")}, before travel and acceleration.</p>{p.plan.sheets.map((s, i) => <div key={s.id} className="space-y-2"><h4 className="font-semibold">Sheet {i + 1}: {s.name || s.id} · {countOf(s.parts.length, "part")}</h4><LaserDrawing design={p.plan.design} parts={s.parts} width={s.width} height={s.height} free={s.remaining} used={s.used_outlines} />{s.nesting_note ? <p data-testid="nesting-note" className="rounded border border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 text-amber-900 dark:text-amber-200">{s.nesting_note}</p> : <p>{s.nesting === "outline" ? "Nested by outline" : "Nested by rectangle"}</p>}</div>)}</div>)}</div><div className="flex flex-wrap gap-3">{data.layouts.some(p => b.plan_ids.includes(p.id) && p.run_id) && <Link className={button} to="/digifab">Manage Production runs</Link>}{b.plan_ids.length ? <button className={button} disabled={busy} onClick={() => void dispatch("queue", { id: b.id })}>Verify and queue batch</button> : <button className={button} disabled={busy} onClick={() => void dispatch("plan", { id: b.id })}>Retry preview</button>}<button className={button} disabled={busy} onClick={() => void dispatch("cancel", { id: b.id })}>Withdraw batch</button></div></>}</section>)}
  </>}
 </div>;
 return screen ? <><SkipToContent /><main id={MAIN_ID} tabIndex={-1} className="min-h-screen bg-surface text-content">{content}</main></> : content;
}
