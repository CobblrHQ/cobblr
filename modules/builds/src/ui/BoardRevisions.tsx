import { AssemblyOrdersCard } from "./AssemblyOrders.js";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FieldPack, QueryError, fieldNeed, RecordFormModal, usePlatformWeb, runAction, downloadBlob, type EntityDetailPanelCtx, NumberField } from "@cobblr/platform-web";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { BoardRevision } from "../api/board-revisions.js";
import type { checkBoardStock } from "../board-revision.js";
import type { BuildsApi } from "./api.js";
import { randomId, countOf } from "@cobblr/platform-contract";
const control = "w-full rounded border border-line bg-surface px-3 py-2 text-sm text-content";
const button = "rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const primary = `${button} bg-cobble-600 text-white`;
export function useBoardAction(slug: string) {
  const { api } = usePlatformWeb();
  const qc = useQueryClient();
  return async <T,>(action: string, args: Record<string, unknown>): Promise<T> => {
    // PRESS-ARGS: each board form supplies its record, quantity and required file or revision fields before the press.
    const out = await runAction(api, qc, slug, { actionId: action, args });
    const result = normaliseActionResult(out.result, action);
    if (!out.ok || !result.ok) throw new Error(typeof result.error === "string" ? result.error : "The request did not complete.");
    return result.data as T;
  };
}
export function BoardProjectPanel({ ctx, api }: { ctx: EntityDetailPanelCtx; api: BuildsApi }) {
  const call = useBoardAction(ctx.slug);
  const qc = useQueryClient();
  const project = { project_id: ctx.entityId, project_kind: ctx.kind ?? "projects:project" };
  const key = ["board-revisions", ctx.slug, ctx.entityId];
  const revisions = useQuery({ queryKey: key, queryFn: () => api.boardProject(ctx.entityId, project.project_kind) });
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState("");
  const [bom, setBom] = useState("");
  const [positions, setPositions] = useState("");
  const [format, setFormat] = useState("kicad");
  const [units, setUnits] = useState("mm");
  const [mirrored, setMirrored] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const operation = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); }, onError: e => setError(e instanceof Error ? e.message : "The request did not complete.") });
  const busy = operation.isPending;
  if (revisions.isError) return <QueryError what="board revisions" onRetry={() => { void revisions.refetch(); }} />;
  if (!revisions.data?.enabled) return null;
  async function read(file: File | undefined, set: (text: string) => void) {
    if (!file) return;
    if (file.size > 2_000_000) { setError("Use a file smaller than 2 MB."); return; }
    try { set(await file.text()); setError(""); } catch { setError("That file could not be read."); }
  }
  return <section className="space-y-3 rounded border border-line p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Board revisions</h3><button type="button" className={button} onClick={() => setOpen(true)}>Import board revision</button></div>
    {revisions.data.revisions.length === 0 ? <p className="text-sm text-muted">Import a BOM and its pick-and-place file for your first revision.</p> : <ul className="space-y-2">{revisions.data.revisions.map(r => <li key={r.id}><Link className="text-accent underline" to={`/builds/${r.id}`}>{r.name}</Link></li>)}</ul>}
    {open && <RecordFormModal open onClose={() => setOpen(false)} title="Import board revision">
      <form className="space-y-4" onSubmit={async e => {
        e.preventDefault();
        operation.mutate(async () => { await call("builds:save-board-revision", { ...project, revision, bom, positions, format, units, bottom_x_mirrored: mirrored, ...(format === "kicad" ? {} : { mapping }), notes }); await qc.invalidateQueries({ queryKey: key }); setOpen(false);
        });
      }}>
        <p className="text-sm text-muted">Export populated components only. Keep the same origin for both board sides. Changed files need a new revision name.</p>
        <FieldPack maxCols={2} items={[
          { need: fieldNeed("revision", { control: "text", label: "Revision" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Revision</span><input aria-label="Revision" required value={revision} onChange={e => setRevision(e.target.value)} className={control} /></label> },
          { need: fieldNeed("format", { control: "choice", label: "Export format" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Export format</span><select aria-label="Export format" value={format} onChange={e => setFormat(e.target.value)} className={control}><option value="kicad">KiCad</option><option value="altium">Altium CSV</option><option value="eagle">Eagle CSV</option></select></label> },
          { need: fieldNeed("bom", { control: "picker", label: "BOM CSV" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">BOM CSV</span><input aria-label="BOM CSV" type="file" accept=".csv,.txt" onChange={e => void read(e.target.files?.[0], setBom)} className={control} /></label> },
          { need: fieldNeed("positions", { control: "picker", label: "Centroid file" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Centroid file</span><input aria-label="Centroid file" type="file" accept=".csv,.pos,.txt" onChange={e => void read(e.target.files?.[0], setPositions)} className={control} /></label> },
          { need: fieldNeed("units", { control: "choice", label: "Exported coordinate units" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Exported coordinate units</span><select aria-label="Exported coordinate units" value={units} onChange={e => setUnits(e.target.value)} className={control}><option value="mm">Millimetres</option><option value="in">Inches</option></select></label> },
          { need: fieldNeed("mirrored", { control: "checkbox", label: "Bottom X coordinates were mirrored on export" }), node: <label className="flex gap-2 text-sm"><input type="checkbox" checked={mirrored} onChange={e => setMirrored(e.target.checked)} />Bottom X coordinates were mirrored on export</label> },
          { need: fieldNeed("notes", { control: "markdown", label: "Revision notes" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Revision notes</span><textarea aria-label="Revision notes" value={notes} onChange={e => setNotes(e.target.value)} className={control} /></label> },
        ]} />
        <p className="text-sm text-muted">{bom ? "BOM selected." : "Select the BOM."} {positions ? "Centroid selected." : "Select the centroid file."}</p>
        {format !== "kicad" && <fieldset className="space-y-2"><legend className="font-semibold">Confirm CSV column headings</legend><FieldPack maxCols={2} items={["ref", "value", "package", "mpn", "manufacturer", "x", "y", "rotation", "side"].map(name => ({ need: fieldNeed(name, { control: "text", label: name }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Column {name}</span><input aria-label={`Column ${name}`} value={mapping[name] ?? ""} onChange={e => setMapping({ ...mapping, [name]: e.target.value })} className={control} required={name !== "value" && name !== "manufacturer"} /></label> }))} /><p className="text-sm text-muted">Use the same heading for references and footprints in the two files.</p></fieldset>}
        {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
        <button type="submit" className={primary} disabled={busy || !bom || !positions}>{busy ? "Importing…" : "Import revision"}</button>
      </form>
    </RecordFormModal>}
  </section>;
}
export function BoardRevisionCard({ slug, id, spec, api }: { slug: string; id: string; spec: BoardRevision; api: BuildsApi }) {
  const call = useBoardAction(slug);
  const qc = useQueryClient();
  const [boards, setBoards] = useState(50);
  const [checked, setChecked] = useState<ReturnType<typeof checkBoardStock> | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const operation = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); }, onError: e => setError(e instanceof Error ? e.message : "The request did not complete.") });
  const busy = operation.isPending;
  const [distributor, setDistributor] = useState("mouser");
  const [expected, setExpected] = useState("");
  const [tracking, setTracking] = useState("");
  const [vendor, setVendor] = useState("JLCPCB");
  const [fileId, setFileId] = useState("");
  const [orderKey, setOrderKey] = useState(() => randomId());
  const [orderId, setOrderId] = useState("");
  const [style, setStyle] = useState("frameless");
  const files = useQuery({ queryKey: ["board-files", slug, id], queryFn: () => api.boardRevision(id) });
  function run(task: () => Promise<void>) { setMessage(""); operation.mutate(task); }
  return <section className="space-y-4" data-testid="board-revision">
    <AssemblyOrdersCard slug={slug} buildId={id} api={api} />
    <p>Revision {spec.revision} · {countOf(spec.placements.length, "placement")} · {spec.bom.length} BOM lines</p>
    <Link className="underline text-accent" to={`/instances/${spec.project_kind.split(":")[0]}/${spec.project_id}`}>Open board project</Link>
    <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Boards to make<NumberField label="Boards to make" className={control} min={1} max={1_000_000} value={boards} onChange={(n) => { setBoards(n); setChecked(null); }} /></label><button type="button" disabled={busy} className={button} onClick={() => void run(async () => setChecked(await call("builds:check-board-stock", { build_id: id, boards })))}>Check BOM stock</button></div>
    {checked && <div className="space-y-2"><p role="status">{checked.ready ? "Component stock is ready." : "Components are short. Check the quantities and moisture warnings."}</p>
      <div className="space-y-3 sm:hidden">{checked.lines.map((l, i) => <div key={i} className="rounded border border-line p-3 space-y-2"><p className="font-semibold break-all">{l.mpn}</p><dl className="grid grid-cols-2 gap-x-4 gap-y-1">{[["On hand", l.on_hand], ["Reserved", l.reserved], ["Needed", l.required], ["Short", l.short]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd>{value}</dd></div>)}</dl>{l.msl_problems.map(p => <p key={p.part_id} data-testid="msl-problem" className="text-sm text-red-700 dark:text-red-300">{p.reason}</p>)}</div>)}</div>
      <div className="hidden sm:block overflow-x-auto"><table className="w-full text-sm"><thead><tr>{["MPN", "On hand", "Reserved", "Needed", "Short", "Moisture"].map(h => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{checked.lines.map((l, i) => <tr key={i} className="border-t border-line"><td className="p-2">{l.mpn}</td><td className="p-2">{l.on_hand}</td><td className="p-2">{l.reserved}</td><td className="p-2">{l.required}</td><td className="p-2">{l.short}</td><td className="p-2" data-testid={l.msl_problems.length ? "msl-problem" : undefined}>{l.msl_problems.length ? l.msl_problems.map(p => p.reason).join(" ") : "No blocked packages"}</td></tr>)}</tbody></table></div>
      <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Distributor<select aria-label="Distributor" value={distributor} onChange={e => setDistributor(e.target.value)} className={control}><option value="digikey">Digi-Key</option><option value="mouser">Mouser</option><option value="lcsc">LCSC</option></select></label><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { const out = await call<{ csv: string; filename: string }>("builds:board-cart", { build_id: id, boards, distributor }); downloadBlob(new Blob([out.csv], { type: "text/csv" }), out.filename); setMessage("Cart downloaded. Upload it to the distributor and confirm MPN, quantity and manufacturer columns."); })}>Download shortage cart</button>
      <button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
        const fresh = await call<ReturnType<typeof checkBoardStock>>("builds:check-board-stock", { build_id: id, boards }); setChecked(fresh);
        const lines = fresh.lines.filter(l => l.short > 0).map(l => ({ description: `${l.manufacturer} ${l.mpn}`, qty: l.short }));
        if (!lines.length) { setMessage("No component shortage to order."); return; }
        const out = await call<{ order_id: string }>("purchases:plan-order", { request_key: `components:${id}:${orderKey}`, vendor: distributor === "digikey" ? "Digi-Key" : distributor === "lcsc" ? "LCSC" : "Mouser", lines, add_to_stock: false, ...(expected ? { expected_arrival: expected } : {}), notes: `Components for revision ${spec.revision}. Receive each package by scanning its distributor label.` }); setOrderId(out.order_id); setMessage("Component purchase recorded. Place the order with the distributor and receive its packages by scan.");
      })}>Track component purchase</button></div>
    </div>}
    <details className="rounded border border-line p-3"><summary className="cursor-pointer font-semibold">Blank boards and fabrication</summary><div className="mt-3 space-y-3">
      <p className="text-sm text-muted">Upload the fab zip, place the order on the fab’s site, and track it here. Mark the purchase arrived to add blank boards to stock.</p>
      <FieldPack maxCols={2} items={[
        { need: fieldNeed("vendor", { control: "choice", label: "Board fab" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Board fab</span><select aria-label="Board fab" className={control} value={vendor} onChange={e => setVendor(e.target.value)}>{["JLCPCB", "PCBWay", "OSH Park"].map(v => <option key={v}>{v}</option>)}</select></label> },
        { need: fieldNeed("zip", { control: "picker", label: "Fabrication zip" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Fabrication zip</span><input aria-label="Fabrication zip" type="file" accept=".zip" className={control} onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { const out = await api.uploadBoardFile(file); setFileId(out.id); setOrderKey(randomId()); setMessage("Fabrication zip selected."); }); }} /></label> },
        { need: fieldNeed("expected", { control: "date", label: "Expected arrival" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Expected arrival</span><input aria-label="Expected arrival" type="date" value={expected} onChange={e => setExpected(e.target.value)} className={control} /></label> },
        { need: fieldNeed("parcelTracking", { control: "text", label: "Tracking number" }), node: <label className="space-y-1 block text-sm"><span className="block text-muted">Tracking number</span><input aria-label="Tracking number" value={tracking} onChange={e => setTracking(e.target.value)} className={control} /></label> },
      ]} />
      <button type="button" className={primary} disabled={busy || !fileId} onClick={() => void run(async () => { const out = await call<{ order_id: string }>("builds:order-blank-boards", { build_id: id, vendor, qty: boards, request_key: `fab:${id}:${orderKey}`, source_file_id: fileId, ...(expected ? { expected_arrival: expected } : {}), ...(tracking ? { tracking_number: tracking } : {}) }); setOrderId(out.order_id); await qc.invalidateQueries({ queryKey: ["board-files", slug, id] }); setMessage("Fabrication purchase recorded."); })}>Track fab order for {boards} boards</button>
    </div></details>
    <div className="flex flex-wrap items-end gap-2"><label className="text-sm">Stencil<select aria-label="Stencil style" value={style} onChange={e => setStyle(e.target.value)} className={control}><option value="frameless">Frameless</option><option value="framed">Framed</option></select></label><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await call("builds:link-board-stencil", { build_id: id, style }); await qc.invalidateQueries({ queryKey: ["builds-detail", id] }); setMessage("Stencil stock record linked. Record its received count on the stock page."); })}>Record revision stencil</button></div>
    {spec.stencil_id && <Link className="underline text-accent" to={`/instances/${spec.stencil_kind.split(":")[0]}/parts/${spec.stencil_id}`}>Open revision stencil</Link>}
    {spec.blank_part_id && <Link className="underline text-accent" to={`/instances/${spec.blank_kind.split(":")[0]}/parts/${spec.blank_part_id}`}>Open blank board stock</Link>}
    {files.data && <ul className="text-sm">{files.data.files.map(f => <li key={f.fileId}>{f.role}: {f.filename}</li>)}</ul>}
    {orderId && <Link className="block underline text-accent" to={`/purchases/orders/${orderId}`}>Open purchase</Link>}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
  </section>;
}
