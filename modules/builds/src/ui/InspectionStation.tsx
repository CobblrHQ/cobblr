import { countOf } from "@cobblr/platform-contract/plural";
import { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NumberField, QueryError, useConfirm, usePageTitle, useStationWakeLock, usePasteImage } from "@cobblr/platform-web";
import { useBoardAction } from "./BoardRevisions.js";
import { InspectionPhotos, inspectionButton as button, inspectionInput as input } from "./Inspection.js";
import type { BuildsApi } from "./api.js";
export function InspectionStation({ slug, machineId, orderId, api }: { slug: string; machineId: string; orderId: string; api: BuildsApi }) {
 usePageTitle("Inspection station"); const call = useBoardAction(slug), confirm = useConfirm(), qc = useQueryClient();
 const key = `cobblr.assembly-station.${slug}.${machineId}.inspection`;
 const [credential, setCredential] = useState<{ id: string; token: string } | null>(null), [ordinal, setOrdinal] = useState(1), [front, setFront] = useState(""), [back, setBack] = useState(""), [status, setStatus] = useState<"pass" | "fail">("fail"), [defects, setDefects] = useState<string[]>([]), [notes, setNotes] = useState(""), [serial, setSerial] = useState(""), [tested, setTested] = useState(false), [error, setError] = useState("");
 useEffect(() => { try { setCredential(JSON.parse(localStorage.getItem(key) || "null")); } catch { setCredential(null); } }, [key]);
 const order = useQuery({ queryKey: ["assembly-order", slug, orderId], queryFn: () => api.assemblyOrder(orderId) });
 const resources = useQuery({ queryKey: ["inspection-resources", slug, orderId, ordinal], queryFn: () => api.inspectionResources(orderId, ordinal) });
 const current = resources.data?.items[0];
 const area = useRef<HTMLFormElement>(null), [photoSide, setPhotoSide] = useState<"Front" | "Back">("Front");
 useEffect(() => { setFront(current?.front_file_id ?? ""); setBack(current?.back_file_id ?? ""); setStatus(current?.status === "pass" ? "pass" : "fail"); setDefects(current?.defects ?? []); setNotes(current?.notes ?? ""); setSerial(current?.serial_code ?? ""); setTested(false); }, [current?.id, current?.revision, ordinal]);
 const operation = useMutation({ mutationFn: async (task: () => Promise<void>) => { setError(""); await task(); await qc.invalidateQueries({ queryKey: ["inspection-resources", slug, orderId] }); await qc.invalidateQueries({ queryKey: ["assembly-order", slug, orderId] }); }, onError: e => setError((e as Error).message) });
 usePasteImage(area, { accept: "image/jpeg,image/png,image/webp", enabled: !!credential && !operation.isPending && !order.data?.assembly.finish_intent, onFiles: files => { const file = files[0]; if (file) operation.mutate(async () => { const out = await api.uploadBoardFile(file); (photoSide === "Front" ? setFront : setBack)(out.id); }); } });
 const bench = order.data?.assembly.inspection_machine, belongs = bench?.id === machineId;
 const locked = !!order.data?.assembly.finish_intent || order.data?.assembly.state === "tested";
 useStationWakeLock(!!credential && belongs && !locked);
 return <main id="main-content" className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4"><header className="flex flex-wrap gap-3 items-center"><h1 className="text-2xl font-semibold flex-1">Inspection station</h1><Link className={button} to="/machines">Machines</Link></header>
 {(order.isError || resources.isError) && <QueryError what="the inspection batch" onRetry={() => { void order.refetch(); void resources.refetch(); }} />}
 {order.data && !belongs && <p role="alert">Choose this inspection bench on the work order before recording evidence here.</p>}
 {belongs && <>
 {resources.data && <p role="status">{resources.data.counts.inspected} of {countOf(resources.data.counts.total, "board")} inspected · {resources.data.counts.accepted} passed</p>}
 {!credential && <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold">Authorize this inspection screen</h2><p>An owner or admin must authorize the screen beside this bench.</p><button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { const next = await api.authorizeMachineStation(bench!.kind, machineId, "inspection"); localStorage.setItem(key, JSON.stringify({ id: next.id, token: next.token })); setCredential(next); })}>Authorize inspection station</button></section>}
 <label className="block">Board number<NumberField label="Board number" disabled={operation.isPending} integer min={1} max={order.data?.qty} className={input} value={ordinal} onChange={setOrdinal} /></label>
 {front && back && <InspectionPhotos slug={slug} front={front} back={back} />}
 {locked && <p>The batch is finishing or finished. Its captured evidence is locked.</p>}
 {credential && !locked && <form ref={area} className="space-y-4" onSubmit={e => { e.preventDefault(); operation.mutate(async () => { await call("builds:inspect-board", { order_id: orderId, station_token: credential.token, ordinal, revision: current?.revision ?? 0, front_file_id: front, back_file_id: back, status, defects, notes, serial_code: serial || null, confirmed_tested: tested }); }); }}>
 <label className="block">Paste photo for<select className={input} aria-label="Paste photo for" value={photoSide} onChange={e => setPhotoSide(e.target.value as "Front" | "Back")}><option>Front</option><option>Back</option></select></label>
 <div className="grid gap-3 sm:grid-cols-2">{(["Front", "Back"] as const).map(side => <label key={side} className="block">{side} photo<input aria-label={`${side} photo`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className={input} disabled={operation.isPending} onChange={e => { const file = e.target.files?.[0]; if (file) operation.mutate(async () => { const out = await api.uploadBoardFile(file); (side === "Front" ? setFront : setBack)(out.id); }); }} /></label>)}</div>
 <label className="block">Test result<select aria-label="Test result" className={input} value={status} onChange={e => setStatus(e.target.value as "pass" | "fail")}><option value="fail">Fail</option><option value="pass">Pass</option></select></label>
 <fieldset className="rounded border border-line p-3"><legend>Defect tags</legend><div className="flex flex-wrap gap-3">{["bridge", "tombstone", "missing", "polarity", "other"].map(defect => <label className="min-h-11 flex items-center gap-2" key={defect}><input type="checkbox" checked={defects.includes(defect)} onChange={e => setDefects(e.target.checked ? [...defects, defect] : defects.filter(d => d !== defect))} />{defect}</label>)}</div></fieldset>
 <label className="block">Inspection and rework notes<textarea aria-label="Inspection and rework notes" className={input} maxLength={4000} value={notes} onChange={e => setNotes(e.target.value)} /></label><label className="block">Optional board serial<input aria-label="Optional board serial" maxLength={160} className={input} value={serial} onChange={e => setSerial(e.target.value)} /></label>
 <label className="flex min-h-11 gap-2 items-center"><input required type="checkbox" checked={tested} onChange={e => setTested(e.target.checked)} />I inspected and tested this board.</label><button className={button} disabled={operation.isPending || !front || !back || !tested}>Save board inspection</button>
 </form>}
 {current && <Link className="text-accent underline block min-h-11 py-2" to={`/builds/inspections/${current.id}`}>Open saved evidence and board QR label</Link>}
 {credential && <><p>Finish when every decision is final. Passed boards become tested stock. Failed boards remain in placed stock for separate rework.</p><button className={button} disabled={operation.isPending || !resources.data || resources.data.counts.inspected !== resources.data.counts.total || order.data?.assembly.state === "tested"} onClick={() => operation.mutate(async () => { if (await confirm({ title: "Finish inspected batch?", message: "Lock the photos, decisions and lot history. Only passed boards move to assembled and tested stock. Failed boards stay separate.", confirmLabel: "Finish batch" })) await call("builds:finish-assembly", { order_id: orderId, station_token: credential.token, confirmed_all_boards: true }); })}>Finish inspected batch</button><details className="rounded border border-line p-3"><summary className="min-h-11 cursor-pointer">Station settings</summary><button className={button} disabled={operation.isPending} onClick={() => operation.mutate(async () => { await api.revokeMachineStation(credential.id); localStorage.removeItem(key); setCredential(null); })}>Revoke this station</button></details></>}
 </>}{error && <p role="alert" className="text-ember-700 dark:text-ember-300">{error}</p>}
 </main>;
}
