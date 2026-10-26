import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FieldPack, fieldNeed, NumberField, QueryError, useStationWakeLock, useConfirm, usePageTitle, useCan, useRoleAtLeast } from "@cobblr/platform-web";
import { reflowTarget } from "@cobblr/platform-contract/reflow-profile";
import { useBoardAction } from "./BoardRevisions.js";
import { ReflowReport } from "./Reflow.js";
import type { BuildsApi } from "./api.js";
import { countOf } from "@cobblr/platform-contract/plural";
const button = "min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
const input = "block w-full rounded border border-line bg-surface p-3";
export function ReflowStation({ slug, machineId, orderId, api }: { slug: string; machineId: string; orderId: string; api: BuildsApi }) {
 usePageTitle("Reflow station");
 const setsUp = useRoleAtLeast(ADMIN_TIER), mayRevoke = useCan("digifab:revoke-station");
 const call = useBoardAction(slug), confirm = useConfirm(), qc = useQueryClient();
 const key = `cobblr.assembly-station.${slug}.${machineId}.reflow`;
 const [credential, setCredential] = useState<{ id: string; token: string } | null>(null), [error, setError] = useState("");
 useEffect(() => { try { setCredential(JSON.parse(localStorage.getItem(key) || "null")); } catch { setCredential(null); } }, [key]);
 const order = useQuery({ queryKey: ["assembly-order", slug, orderId], queryFn: () => api.assemblyOrder(orderId), refetchInterval: 4000 });
 const run = order.data?.assembly.reflow;
 const [peak, setPeak] = useState(0), [duration, setDuration] = useState(0), [above, setAbove] = useState(0), [notes, setNotes] = useState("");
 const refresh = async () => { await qc.invalidateQueries({ queryKey: ["assembly-order", slug, orderId] }); };
 const mutation = { mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); await refresh(); }, onError: (e: unknown) => setError(e instanceof Error ? e.message : "The oven did not confirm this step.") };
 const operation = useMutation({ ...mutation, onError: mutation.onError }), stop = useMutation({ ...mutation, onError: mutation.onError });
 const active = !!run && ["starting", "running", "uncertain"].includes(run.state), open = run?.model === "t962-ue" || run?.model === "yarc";
 const belongs = !!run && run.machine_id === machineId;
 useStationWakeLock(active);
 const args = () => ({ order_id: orderId, station_token: credential?.token, confirmed_all_boards: true });
 async function startRun() {
  const agreed = await confirm({ title: "Start reflow?", message: run?.model === "t962-ue" ? `Confirm all ${countOf(Number(order.data?.qty ?? 0), "board")} are loaded and this oven is clear. This sends one heat command using the verified profile.` : `Confirm all ${countOf(Number(order.data?.qty ?? 0), "board")} are loaded, the selected profile matches the oven and you are starting it at its own controls.`, confirmLabel: "Confirm and start" });
  if (agreed) operation.mutate(async () => { await call("builds:start-reflow", args()); });
 }
 async function stopRun() {
  const agreed = await confirm({ title: "Stop this reflow run?", message: run?.model === "t962-ue" ? "Send Stop to the oven and keep the interrupted run for review." : "Stop the oven at its own controls, then confirm it has stopped. This records the interruption and stops bridge monitoring.", confirmLabel: "Confirm stop" });
  if (agreed) stop.mutate(async () => { await call("builds:stop-reflow", args()); });
 }
 return <main id="main-content" className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4"><header className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold flex-1">Reflow station</h1><Link className={button} to="/machines">Machines</Link></header>
 {order.isError && <QueryError what="the oven work order" onRetry={() => void order.refetch()} />}
 {!run && order.data && <p>Prepare a paste profile and oven on this work order first.</p>}
 {run && !belongs && <p role="alert">This batch belongs to another oven. Open its station from the work order.</p>}
 {belongs && run && <>
 <p>{countOf(Number(order.data?.qty ?? 0), "board")} · {run.profile.name} · {run.state}</p>
 {!credential && <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold">Set up this screen beside the oven</h2><p>An owner or admin must authorize this screen before it can send a profile or record a run.</p>{setsUp && <button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { const next = await api.authorizeMachineStation(run.machine_kind, machineId, "reflow"); localStorage.setItem(key, JSON.stringify({ id: next.id, token: next.token })); setCredential(next); })}>Authorize reflow station</button>}</section>}
 {credential && <>
 <p className="text-sm">{run.model === "t962-ue" ? "The bridge selects the checked firmware slot and records its actual temperature reports." : run.model === "yarc" ? "Upload the profile here, then Start at YARC's oven controls. The bridge records its temperature reports." : "Load the selected profile on the oven. Record measured values after its full cooldown."}</p>
 {["prepared", "controller-prepared"].includes(run.state) && <div className="flex flex-wrap gap-3"><button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { if (!open && !await confirm({ title: "Confirm oven profile?", message: "Check the profile loaded on this oven against the selected paste profile before confirming.", confirmLabel: "Confirm profile" })) return; await call("builds:send-reflow-profile", args()); })}>{open ? "Send oven profile" : "Confirm loaded oven profile"}</button><button className={button} disabled={operation.isPending || run.state !== "controller-prepared" || run.station_id !== credential.id} onClick={() => void startRun()}>Start reflow</button></div>}
 {active && <div className="space-y-3"><div className="flex flex-wrap gap-3">{open && <button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { await call("builds:sample-reflow", args()); })}>Record temperature curve</button>}<button className={`${button} border-ember-500`} disabled={stop.isPending} onClick={() => void stopRun()}>Stop reflow</button></div>
 {run.state === "uncertain" && <p role="alert">Start or recording was not confirmed. Check the oven. Do not resend Start; stop it or record a manual recovery.</p>}
 {open && run.state !== "uncertain" && <button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { if (await confirm({ title: "Record completed reflow?", message: "Confirm this batch completed reflow and cooldown. The recorded curve will be checked against the paste limits.", confirmLabel: "Record completion" })) await call("builds:finish-reflow", { ...args(), source: "controller", notes }); })}>Record controller completion</button>}
 <form className="rounded border border-line p-4 space-y-3" onSubmit={e => { e.preventDefault(); operation.mutate(async () => { if (!await confirm({ title: "Record manual reflow?", message: "Confirm these are measured values for the completed batch, including cooldown. Limit violations remain flagged for inspection.", confirmLabel: "Save measured log" })) return; await call("builds:finish-reflow", { ...args(), source: open ? "manual-recovery" : "manual", peak_c: Number(peak), duration_s: Number(duration), above_liquidus_s: Number(above), notes }); }); }}><h2 className="text-xl font-semibold">{open ? "Manual recovery log" : "Measured reflow log"}</h2><FieldPack items={[["Measured peak C", peak, setPeak], ["Total duration seconds", duration, setDuration], ["Time above liquidus seconds", above, setAbove]].map(([label, value, setter]) => ({ need: fieldNeed(String(label), { label: String(label), control: "number" }), node: <label className="block">{String(label)}<NumberField label={String(label)} required min={label === "Total duration seconds" ? 1 : 0} className={input} value={value as number} onChange={setter as (v: number) => void} /></label> }))} /><label className="block">{open ? "Controller problem and recovery" : "Run notes"}<textarea aria-label={open ? "Controller problem and recovery" : "Run notes"} className={input} required={open} minLength={open ? 10 : undefined} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></label><button type="submit" className={button} disabled={operation.isPending}>Save measured reflow log</button></form>
 </div>}
 {!!run.samples?.length && <TemperatureCurve run={run} />}
 {run.report && <ReflowReport run={run} />}
 <details className="rounded border border-line p-3"><summary className="cursor-pointer min-h-11">Station settings</summary>{mayRevoke && <button className={`${button} mt-3`} disabled={operation.isPending || stop.isPending} onClick={() => operation.mutate(async () => { await api.revokeMachineStation(credential.id); localStorage.removeItem(key); setCredential(null); })}>Revoke this station</button>}</details>
 </>}
 </>}
 {error && <p role="alert" className="text-ember-700 dark:text-ember-300">{error}</p>}
 </main>;
}
function TemperatureCurve({ run }: { run: NonNullable<Awaited<ReturnType<BuildsApi["assemblyOrder"]>>["assembly"]["reflow"]> }) {
 const samples = run.samples ?? [], total = Math.max(1, run.profile.phases.reduce((sum, p) => sum + p.seconds, 0), samples.at(-1)?.seconds ?? 0), max = Math.max(50, run.profile.limits.max_peak_c, ...samples.map(s => s.celsius));
 const point = (seconds: number, celsius: number) => `${40 + seconds / total * 600},${250 - celsius / max * 220}`;
 let seconds = 0;
 const target = [point(0, run.profile.limits.ambient_c), ...run.profile.phases.map(p => { seconds += p.seconds; return point(seconds, reflowTarget(run.profile, seconds)); })].join(" ");
 return <figure className="rounded border border-line p-3"><figcaption className="text-sm">Temperature curve: solid measured, dashed paste profile</figcaption><svg viewBox="0 0 660 290" role="img" aria-label="Measured oven temperature against paste profile" className="w-full"><line x1="40" y1="250" x2="640" y2="250" stroke="currentColor" /><line x1="40" y1="30" x2="40" y2="250" stroke="currentColor" /><polyline points={target} fill="none" stroke="currentColor" strokeDasharray="5 5" strokeWidth="2" /><polyline points={samples.map(s => point(s.seconds, s.celsius)).join(" ")} fill="none" stroke="var(--color-accent, #2589b9)" strokeWidth="3" /><text x="40" y="275" fill="currentColor" fontSize="14">0 s</text><text x="590" y="275" fill="currentColor" fontSize="14">{Math.round(total)} s</text><text x="4" y="25" fill="currentColor" fontSize="14">{Math.round(max)} C</text></svg></figure>;
}
