import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryError, useStationWakeLock, useConfirm, usePageTitle, downloadBlob, useCan, useRoleAtLeast } from "@cobblr/platform-web";
import { useBoardAction } from "./BoardRevisions.js";
import type { BuildsApi } from "./api.js";
import { countOf } from "@cobblr/platform-contract/plural";
const button = "min-h-12 rounded border border-line px-4 py-3 text-base disabled:opacity-50";
export function AssemblyStation({ slug, machineId, orderId, api, camera }: { slug: string; machineId: string; orderId: string; api: BuildsApi; camera: (onCode: (code: string) => void, onClose: () => void) => ReactNode }) {
  usePageTitle("Placement station");
  const setsUp = useRoleAtLeast(ADMIN_TIER), mayRevoke = useCan("digifab:revoke-station");
  const call = useBoardAction(slug), confirm = useConfirm(), qc = useQueryClient();
  const key = `cobblr.assembly-station.${slug}.${machineId}.placement`;
  const [credential, setCredential] = useState<{ id: string; token: string } | null>(null);
  useEffect(() => { try { setCredential(JSON.parse(localStorage.getItem(key) || "null")); } catch { setCredential(null); } }, [key]);
  const [error, setError] = useState(""), [slot, setSlot] = useState(""), [code, setCode] = useState(""), [scanning, setScanning] = useState(false);
  const order = useQuery({ queryKey: ["assembly-order", slug, orderId], queryFn: () => api.assemblyOrder(orderId), refetchInterval: 4000 });
  const program = useQuery({ queryKey: ["placement-program", slug, orderId], queryFn: () => api.placementProgram(orderId) });
  const run = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); await qc.invalidateQueries({ queryKey: ["assembly-order", slug, orderId] }); }, onError: e => setError(e instanceof Error ? e.message : "This step did not complete.") });
  useStationWakeLock(order.data?.assembly.state === "placing");
  const placement = order.data?.assembly.placement;
  const ready = !!credential && !!placement && placement.feeders.every(f => placement.verified[f.slot]?.part_id === f.part_id && placement.verified[f.slot]?.station_id === credential.id);
  const sides = [...new Set(program.data?.placements.map(p => p.side) ?? [])];
  const scan = (value: string) => { setScanning(false); run.mutate(async () => { if (!credential || !slot) throw new Error("Choose the loaded feeder slot first."); await call("builds:verify-feeder", { order_id: orderId, station_token: credential.token, slot, code: value }); setCode(""); }); };
  async function step(side: "top" | "bottom", operation: "start" | "finish") {
    if (!credential) return;
    const agreed = await confirm({ title: operation === "start" ? `Start ${side} side?` : `Complete ${side} side?`, message: operation === "start" ? `Confirm all ${countOf(Number(order.data?.qty ?? 0), "board")} are loaded, the exported ${side} program is selected and its package calibrations match this machine.` : `Confirm every placement on all ${countOf(Number(order.data?.qty ?? 0), "board")} completed. The last side draws the reserved reels and blank boards and adds placed board stock.`, confirmLabel: operation === "start" ? "Confirm and start" : "Confirm completion" });
    if (agreed) run.mutate(async () => { await call(`builds:${operation}-placement`, { order_id: orderId, station_token: credential.token, side, source: "manual", confirmed_all_boards: true }); });
  }
  return <main className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4" id="main-content">
    <header className="flex flex-wrap gap-3 items-center"><h1 className="text-2xl font-semibold flex-1">Placement station</h1><Link to="/machines" className={button}>Machines</Link></header>
    {order.isError && <QueryError what="assembly work order" onRetry={() => void order.refetch()} />}
    {program.isError && <QueryError what="placement program" onRetry={() => void program.refetch()} />}
    {!credential && <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold">Set up this screen at the machine</h2><p>An owner or admin must authorize this screen beside the machine before it can verify feeders or record a run.</p>{setsUp && <button className={button} disabled={run.isPending || !placement || placement.machine_id !== machineId} onClick={() => run.mutate(async () => { if (!placement) return; const next = await api.authorizeMachineStation(placement.machine_kind, machineId, "placement"); localStorage.setItem(key, JSON.stringify({ id: next.id, token: next.token })); setCredential(next); })}>Authorize placement station</button>}</section>}
    {placement && placement.machine_id !== machineId && <p role="alert">This work order belongs to another machine. Open its station from the work order.</p>}
    {placement && placement.machine_id === machineId && <>
      {!order.data?.assembly.paste && <p role="status" className="text-ember-700 dark:text-ember-300">Record paste application on this work order before Start.</p>}
      <p>{countOf(Number(order.data?.qty ?? 0), "board")} · {order.data?.assembly.state} · {placement.profile.model}</p>
      <p className="text-sm text-muted">Load the exported program and check its alignment on the machine. Each package calibration must already have passed a test board.</p>
      {credential && <>
        <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold">Verify loaded reels</h2><ul className="space-y-2">{placement.feeders.map(f => <li key={f.slot}>Slot {f.slot} · {f.mpn} · lot {f.lot_code ?? "unrecorded"} · {placement.verified[f.slot]?.station_id === credential.id && placement.verified[f.slot]?.part_id === f.part_id ? "Verified" : "Unverified"}</li>)}</ul>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); scan(code); }}><label className="block">Loaded slot<select aria-label="Loaded slot" className="block w-full rounded border border-line bg-surface p-3" value={slot} onChange={e => setSlot(e.target.value)} required><option value="">Choose a slot</option>{placement.feeders.map(f => <option key={f.slot} value={f.slot}>{f.slot} · {f.mpn}</option>)}</select></label><label className="block">Reel QR<input aria-label="Reel QR" className="block w-full rounded border border-line bg-surface p-3" value={code} onChange={e => setCode(e.target.value)} required autoComplete="off" /></label><div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={run.isPending}>Verify reel</button><button type="button" className={button} disabled={!slot || run.isPending} onClick={() => setScanning(true)}>Scan reel QR</button></div></form></section>
        <section className="space-y-3"><h2 className="text-xl font-semibold">Record the run</h2><p className="text-sm">If OpenPnP scripting is available, its exported event scripts report Start and Done. Otherwise use these controls beside the machine. Vendor machines use these controls after loading their CSV.</p>{sides.map(side => <div key={side} className="rounded border border-line p-3 flex flex-wrap items-center gap-3"><span className="capitalize flex-1">{side} side</span>{placement.sides[side]?.completed_at ? <span>Completed</span> : placement.sides[side]?.started_at ? <button className={button} disabled={run.isPending} onClick={() => void step(side, "finish")}>Done {side} side</button> : <button className={button} disabled={!ready || run.isPending || order.data?.assembly.state !== "pasted" && order.data?.assembly.state !== "placing"} onClick={() => void step(side, "start")}>Start {side} side</button>}</div>)}</section>
        <details className="rounded border border-line p-3"><summary className="cursor-pointer min-h-11">Station settings</summary><div className="space-y-3 pt-3"><p className="text-sm">For OpenPnP scripting, save this station credential as ~/.secrets/cobblr-assembly-station-token on its computer. Save a workspace API key separately as ~/.secrets/cobblr-assembly-api-token. Set COBBLR_URL and COBBLR_WORKSPACE before starting OpenPnP.</p><button className={button} onClick={() => downloadBlob(new Blob([credential.token], { type: "text/plain" }), "cobblr-assembly-station-token")}>Download station credential</button>{mayRevoke && <button className={button} disabled={run.isPending} onClick={() => run.mutate(async () => { await api.revokeMachineStation(credential.id); localStorage.removeItem(key); setCredential(null); })}>Revoke this station</button>}</div></details>
      </>}
    </>}
    {scanning && camera(scan, () => setScanning(false))}
    {error && <p role="alert" className="text-ember-700 dark:text-ember-300">{error}</p>}
  </main>;
}
