import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { zipSync, strToU8 } from "fflate";
import { downloadBlob, FieldPack, fieldNeed, QueryError } from "@cobblr/platform-web";
import { useBoardAction } from "./BoardRevisions.js";
import type { BuildsApi } from "./api.js";
import type { BoardRevision } from "../api/board-revisions.js";
import type { AssemblyOrderView } from "../api/assembly-orders.js";
import type { PlacementProfile } from "../placement-program.js";
const input = "w-full rounded border border-line bg-surface p-2 text-sm";
const button = "rounded border border-line px-3 py-2 text-sm min-h-11 disabled:opacity-50";
type Calibration = PlacementProfile["packages"][string];
export function PlacementCard({ slug, order, spec, api }: { slug: string; order: AssemblyOrderView; spec: BoardRevision; api: BuildsApi }) {
  const call = useBoardAction(slug), qc = useQueryClient();
  const resources = useQuery({ queryKey: ["placement-resources", slug], queryFn: () => api.placementResources() });
  const [machineId, setMachineId] = useState(order.assembly.placement?.machine_id ?? ""), [editing, setEditing] = useState(false);
  const [geometry, setGeometry] = useState({ width_mm: "", height_mm: "", origin_x_mm: "0", origin_y_mm: "0", panel_origin_x_mm: "0", panel_origin_y_mm: "0", columns: "1", gap_mm: "3" });
  const [slots, setSlots] = useState<Record<string, string>>({}), [error, setError] = useState("");
  const prepared = order.assembly.placement, editable = ["released", "pasted"].includes(order.assembly.state);
  const machine = resources.data?.machines.find(m => m.id === machineId);
  const operation = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); await qc.invalidateQueries({ queryKey: ["placement-resources", slug] }); await qc.invalidateQueries({ queryKey: ["assembly-order", slug, order.id] }); }, onError: e => setError(e instanceof Error ? e.message : "Placement did not change.") });
  const packages = [...new Set(spec.placements.map(p => p.package))];
  const reels = order.kit.lines.filter(l => l.role === "component").filter((l, i, all) => all.findIndex(other => other.part_id === l.part_id) === i);
  const exportFiles = () => operation.mutate(async () => {
    const program = await api.placementProgram(order.id);
    const archive = zipSync(Object.fromEntries(program.files.map(f => [f.name, strToU8(f.content)])));
    downloadBlob(new Blob([Uint8Array.from(archive)], { type: "application/zip" }), `placement-${order.id}.zip`);
  });
  return <section className="rounded border border-line p-3 space-y-3" data-testid="placement-preparation">
    <h4 className="font-semibold">Pick and place</h4>
    <p className="text-sm text-muted">Export the program, load it on the machine, then verify its reels and record the run at the station.</p>
    {resources.isError && <QueryError what="assembly machines" onRetry={() => { void resources.refetch(); }} />}
    {editable && <>
      <label className="block text-sm">Pick-and-place machine<select aria-label="Pick-and-place machine" className={input} value={machineId} onChange={e => { setMachineId(e.target.value); setEditing(false); }}><option value="">Choose a machine</option>{resources.data?.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <div className="flex flex-wrap items-center gap-3"><Link className="text-sm underline text-accent min-h-11 py-2" to="/machines">Add a machine in Machines</Link>
      {machine && <button type="button" className={button} onClick={() => setEditing(v => !v)}>Edit package calibrations</button>}</div>
      {machine && editing && <MachineCalibrationForm key={machine.id} packages={packages} initial={machine.profile} busy={operation.isPending} save={profile => operation.mutate(async () => { await call("builds:configure-placement-machine", { machine_kind: machine.kind, machine_id: machine.id, ...profile }); setEditing(false); })} />}
      {machine && <form className="space-y-3" onSubmit={e => { e.preventDefault(); operation.mutate(async () => { await call("builds:prepare-placement", { order_id: order.id, machine_kind: machine.kind, machine_id: machine.id, geometry: Object.fromEntries(Object.entries(geometry).map(([k, v]) => [k, Number(v)])), slots }); }); }}>
        <FieldPack items={Object.entries(geometry).map(([key, value]) => ({ need: fieldNeed(key, { control: "number", label: ({ width_mm: "PCB width mm", height_mm: "PCB height mm", origin_x_mm: "Centroid origin offset X mm", origin_y_mm: "Centroid origin offset Y mm", panel_origin_x_mm: "Machine panel origin X mm", panel_origin_y_mm: "Machine panel origin Y mm", columns: "Panel columns", gap_mm: "Board spacing mm" } as Record<string, string>)[key]! }), node: <label className="block text-sm">{({ width_mm: "PCB width mm", height_mm: "PCB height mm", origin_x_mm: "Centroid origin offset X mm", origin_y_mm: "Centroid origin offset Y mm", panel_origin_x_mm: "Machine panel origin X mm", panel_origin_y_mm: "Machine panel origin Y mm", columns: "Panel columns", gap_mm: "Board spacing mm" } as Record<string, string>)[key]}<input aria-label={({ width_mm: "PCB width mm", height_mm: "PCB height mm", origin_x_mm: "Centroid origin offset X mm", origin_y_mm: "Centroid origin offset Y mm", panel_origin_x_mm: "Machine panel origin X mm", panel_origin_y_mm: "Machine panel origin Y mm", columns: "Panel columns", gap_mm: "Board spacing mm" } as Record<string, string>)[key]} required type="number" step={key === "columns" ? "1" : "any"} min={key === "columns" ? 1 : key === "width_mm" || key === "height_mm" ? 0.001 : key.startsWith("origin") ? undefined : 0} className={input} value={value} onChange={e => setGeometry(old => ({ ...old, [key]: e.target.value }))} /></label> }))} />
        <p className="text-sm text-muted">OpenPnP uses the panel grid and measured machine origin. Vendor CSVs place one board at a time. Bottom X is mirrored in vendor files; leave the converter's extra mirror off.</p>
        <h5 className="text-sm font-semibold">Feeder slots</h5>
        {reels.map(reel => <label key={reel.part_id} className="block text-sm">Slot for {reel.name} · lot {reel.lot_code ?? "unrecorded"}<input aria-label={`Slot for ${reel.name}`} required className={input} value={slots[reel.part_id] ?? ""} onChange={e => setSlots(old => ({ ...old, [reel.part_id]: e.target.value }))} /></label>)}
        <button type="submit" className={button} disabled={operation.isPending}>Prepare placement program</button>
      </form>}
    </>}
    {prepared && <div className="space-y-2"><p className="text-sm">Prepared for {prepared.profile.model} · {order.qty} boards</p><button type="button" className={button} disabled={operation.isPending} onClick={exportFiles}>Download placement files</button><Link className="block text-accent underline min-h-11 py-2" to={`/station/assembly/${prepared.machine_id}/${order.id}`}>Open placement station</Link>{["placed", "reflowed", "tested"].includes(order.assembly.state) && <Link className="block text-sm text-accent underline" to={openRecordPath(prepared.output_kind, prepared.output_id)}>Placed board stock</Link>}</div>}
    {error && <p role="alert" className="text-ember-700 dark:text-ember-300">{error}</p>}
  </section>;
}
function MachineCalibrationForm({ packages, initial, busy, save }: { packages: string[]; initial: unknown; busy: boolean; save: (p: { model: PlacementProfile["model"]; packages: Record<string, Calibration>; work_area_width_mm: number; work_area_height_mm: number }) => void }) {
  const existing = initial as { model?: PlacementProfile["model"]; packages?: Record<string, Calibration>; work_area_width_mm?: number; work_area_height_mm?: number } | null;
  const [model, setModel] = useState<PlacementProfile["model"]>(existing?.model ?? "openpnp"), [workWidth, setWorkWidth] = useState(existing?.work_area_width_mm ?? 0), [workHeight, setWorkHeight] = useState(existing?.work_area_height_mm ?? 0);
  const [calibrations, setCalibrations] = useState<Record<string, Calibration>>(() => Object.fromEntries(packages.map(pkg => [pkg, existing?.packages?.[pkg] ?? { package_id: pkg, height_mm: 0, top_zero_deg: 0, bottom_zero_deg: 0, rotation_sign: 1, offset_x_mm: 0, offset_y_mm: 0, nozzle: 1, head: 1, speed_pct: 50, mode: 1, verified_at: "" }])));
  const numberFields = { height_mm: "Package height mm", top_zero_deg: "Top zero rotation degrees", bottom_zero_deg: "Bottom zero rotation degrees", offset_x_mm: "Package offset X mm", offset_y_mm: "Package offset Y mm", nozzle: "Nozzle", head: "Head", speed_pct: "Mount speed percent", mode: "Pickup verification mode" } as const;
  return <form className="rounded border border-line p-3 space-y-3" onSubmit={e => { e.preventDefault(); save({ model, packages: { ...existing?.packages, ...calibrations }, work_area_width_mm: workWidth, work_area_height_mm: workHeight }); }}>
    <p className="text-sm text-muted">Confirm each package on a test board before marking its calibration verified. These values belong to this machine.</p>
    <label className="block text-sm">Machine file format<select aria-label="Machine file format" className={input} value={model} onChange={e => setModel(e.target.value as PlacementProfile["model"])}>{["openpnp", "neoden4", "neoden-yy1", "neoden-k1830", "charmhigh-t48vb", "charmhigh-t36va"].map(m => <option key={m} value={m}>{m}</option>)}</select></label>
    <FieldPack items={[["Work area width mm", workWidth, setWorkWidth], ["Work area height mm", workHeight, setWorkHeight]].map(([label, value, setter]) => ({ need: fieldNeed(String(label), { label: String(label), control: "number" }), node: <label className="block text-sm">{String(label)}<input aria-label={String(label)} required type="number" min={0.001} step="any" className={input} value={value as number} onChange={e => (setter as (v: number) => void)(Number(e.target.value))} /></label> }))} />
    {packages.map(pkg => <details key={pkg} open={packages.length === 1} className="rounded border border-line p-2"><summary className="cursor-pointer min-h-11 flex items-center font-medium break-all">{pkg}</summary><div className="space-y-3 pt-2">
      <label className="block text-sm">Machine package id<input aria-label={`Machine package id for ${pkg}`} className={input} required value={calibrations[pkg]!.package_id} onChange={e => setCalibrations(old => ({ ...old, [pkg]: { ...old[pkg]!, package_id: e.target.value } }))} /></label>
      <FieldPack items={Object.entries(numberFields).map(([key, label]) => ({ need: fieldNeed(key, { label, control: "number" }), node: <label className="block text-sm">{label}<input aria-label={`${label} for ${pkg}`} required type="number" step={["nozzle", "head", "speed_pct", "mode"].includes(key) ? 1 : "any"} min={key === "height_mm" ? 0.001 : ["nozzle", "head", "speed_pct", "mode"].includes(key) ? 1 : undefined} className={input} value={calibrations[pkg]![key as keyof Calibration] as number} onChange={e => setCalibrations(old => ({ ...old, [pkg]: { ...old[pkg]!, [key]: Number(e.target.value) } }))} /></label> }))} />
      <label className="block text-sm">Rotation direction<select aria-label={`Rotation direction for ${pkg}`} className={input} value={calibrations[pkg]!.rotation_sign} onChange={e => setCalibrations(old => ({ ...old, [pkg]: { ...old[pkg]!, rotation_sign: Number(e.target.value) as 1 | -1 } }))}><option value={1}>Counter-clockwise</option><option value={-1}>Clockwise</option></select></label>
      <label className="flex gap-2 text-sm"><input aria-label={`Calibration verified for ${pkg}`} required type="checkbox" checked={!!calibrations[pkg]!.verified_at} onChange={e => setCalibrations(old => ({ ...old, [pkg]: { ...old[pkg]!, verified_at: e.target.checked ? new Date().toISOString() : "" } }))} />Calibration verified on this machine</label>
    </div></details>)}
    <button className={button} disabled={busy} type="submit">Save verified calibrations</button>
  </form>;
}
