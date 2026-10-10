import { countOf } from "@cobblr/platform-contract/plural";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto, Lightbox, QueryError, SearchInput, ContributedDetailPanels, CustomFieldsPanel } from "@cobblr/platform-web";
import type { AssemblyOrderView } from "../api/assembly-orders.js";
import type { BuildsApi } from "./api.js";
import { useBoardAction } from "./BoardRevisions.js";
export const inspectionButton = "min-h-12 rounded border border-line px-4 py-3 disabled:opacity-50";
export const inspectionInput = "block w-full rounded border border-line bg-surface p-3";
export function InspectionCard({ slug, order, api }: { slug: string; order: AssemblyOrderView; api: BuildsApi }) {
 const call = useBoardAction(slug), qc = useQueryClient();
 const resources = useQuery({ queryKey: ["inspection-resources", slug, order.id], queryFn: () => api.inspectionResources(order.id) });
 const [bench, setBench] = useState(order.assembly.inspection_machine?.id ?? ""), [error, setError] = useState("");
 const prepare = useMutation({ mutationFn: async () => { const machine = resources.data?.machines.find(m => m.id === bench); if (!machine) throw new Error("Choose the inspection bench."); await call("builds:prepare-inspection", { order_id: order.id, machine_kind: machine.kind, machine_id: bench }); await qc.invalidateQueries({ queryKey: ["assembly-order", slug, order.id] }); }, onError: e => setError((e as Error).message) });
 return <section className="rounded border border-line p-3 space-y-3"><h3 className="font-semibold">Inspection and finish</h3>
 {resources.isError && <QueryError what="inspection evidence" onRetry={() => void resources.refetch()} />}
 {resources.data && <p>{resources.data.counts.inspected} of {countOf(resources.data.counts.total, "board")} inspected · {resources.data.counts.accepted} passed</p>}
 {order.assembly.state === "reflowed" && !order.assembly.finish_intent && <form className="space-y-3" onSubmit={e => { e.preventDefault(); setError(""); prepare.mutate(); }}><label className="block">Inspection bench<select required aria-label="Inspection bench" className={inspectionInput} value={bench} onChange={e => setBench(e.target.value)}><option value="">Choose a bench</option>{resources.data?.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><button className={inspectionButton} disabled={prepare.isPending}>Prepare inspection</button></form>}
 {order.assembly.inspection_machine && <Link className="block text-accent underline min-h-11 py-2" to={`/station/inspection/${order.assembly.inspection_machine.id}/${order.id}`}>Open inspection station</Link>}
 {order.assembly.finished && <p><Link className="text-accent underline" to={openRecordPath(order.assembly.finished.output_kind, order.assembly.finished.output_id)}>{order.assembly.finished.accepted} assembled and tested boards</Link> · {order.assembly.finished.rejected} failed boards kept in placed stock</p>}
 <ul className="space-y-2">{resources.data?.items.map(board => <li key={board.id}><Link className="text-accent underline" to={`/builds/inspections/${board.id}`}>Board {board.ordinal} · {board.status}{board.serial_code ? ` · ${board.serial_code}` : ""}</Link></li>)}</ul>
 {resources.data?.trace && <AssemblyTrace trace={resources.data.trace} />}
 <RecallSearch slug={slug} api={api} />{error && <p role="alert">{error}</p>}
 </section>;
}
export function AssemblyTrace({ trace }: { trace: NonNullable<Awaited<ReturnType<BuildsApi["inspectionResources"]>>["trace"]> }) {
 return <details className="rounded border border-line p-3"><summary className="min-h-11 cursor-pointer">Captured lots and operators</summary><div className="space-y-2 text-sm break-words"><ul>{trace.reels.map((reel, i) => <li key={`${reel.part_id}:${i}`}><Link className="text-accent underline" to={openRecordPath(reel.kind, reel.part_id)}>Reel {reel.part_id}</Link> · lot {reel.lot_code ?? "unrecorded"} · {countOf(Number(reel.qty), "component")}</li>)}</ul><p>Paste lot {trace.paste.lot_code} · {trace.paste.amount_ml} ml</p><p>Stencil {trace.stencil_id}</p><p>Reflow run {trace.reflow.run_id} · profile {trace.reflow.profile_id} · {trace.reflow.profile_hash}</p><p>Operators {trace.operators.join(", ")}</p></div></details>;
}
function RecallSearch({ slug, api }: { slug: string; api: BuildsApi }) {
 const [value, setValue] = useState(""), [code, setCode] = useState("");
 const result = useQuery({ queryKey: ["assembly-recall", slug, code], queryFn: () => api.assemblyRecall(code), enabled: !!code });
 return <div className="space-y-3"><form onSubmit={e => { e.preventDefault(); setCode(value.trim()); }} className="space-y-2"><label className="block">Find boards by reel ID or lot<SearchInput aria-label="Find boards by reel ID or lot" required maxLength={160} value={value} onChange={setValue} /></label><button className={inspectionButton}>Find finished batches</button></form>{result.isError && <QueryError what="finished batches" onRetry={() => void result.refetch()} />}{result.data && <><p>{result.data.items.length} matching finished batches</p><ul>{result.data.items.map(item => <li key={item.order_id}><Link className="text-accent underline block min-h-11 py-2" to={`/builds/${item.build_id}?order=${item.order_id}`}>{item.finished?.accepted} tested boards · batch {item.order_id.slice(0, 8)}</Link></li>)}</ul></>}</div>;
}
export function InspectionPhotos({ slug, front, back }: { slug: string; front: string; back: string }) {
 const [index, setIndex] = useState<number | null>(null);
 const items = [front, back].map((id, i) => ({ key: id, caption: i ? "Back" : "Front", src: `/api/v1/orgs/${slug}/modules/core-files/files/${id}/raw` }));
 return <><div className="grid grid-cols-2 gap-3">{items.map((item, i) => <button type="button" key={item.key} aria-label={`Inspect ${item.caption.toLowerCase()} photo`} onClick={() => setIndex(i)}><EntityPhoto src={item.src} alt={`${item.caption} of this board`} aspect="square" fit="contain" /><span>{item.caption}</span></button>)}</div>{index !== null && <Lightbox items={items} index={index} onIndex={setIndex} onClose={() => setIndex(null)} />}</>;
}
export function BoardInspection({ slug, id, api, queueLabel }: { slug: string; id: string; api: BuildsApi; queueLabel: (id: string, description: string) => Promise<void> }) {
 const call = useBoardAction(slug), qc = useQueryClient();
 const fields = useMutation({ mutationFn: async (metadata: Record<string, unknown>) => { await call("builds:update-inspection-metadata", { inspection_id: id, metadata }); await qc.invalidateQueries({ queryKey: ["board-inspection", slug, id] }); }, onError: e => setMessage((e as Error).message) });
 const result = useQuery({ queryKey: ["board-inspection", slug, id], queryFn: () => api.inspection(id) }), [message, setMessage] = useState("");
 const label = useMutation({ mutationFn: () => queueLabel(id, result.data?.serial_code || `Board ${result.data?.ordinal}`), onSuccess: () => setMessage("Board QR label queued."), onError: e => setMessage((e as Error).message) });
 if (result.isError) return <QueryError what="board inspection" onRetry={() => void result.refetch()} />;
 const board = result.data;
 return <main id="main-content" className="mx-auto max-w-3xl p-4 space-y-4">{board && <><h1 className="text-2xl font-semibold">Board {board.ordinal} · {board.status}</h1><p>{board.serial_code || "No serial entered"}</p><Link className="text-accent underline" to={`/builds/${board.build_id}?order=${board.order_id}`}>Open work order</Link><InspectionPhotos slug={slug} front={board.front_file_id} back={board.back_file_id} /><p>{board.defects.join(", ")}</p><p className="whitespace-pre-wrap">{board.notes}</p><p>Inspected by {board.inspected_by} · {new Date(board.inspected_at).toLocaleString()}</p><AssemblyTrace trace={board.trace} /><CustomFieldsPanel entityKind="builds:inspection" entityId={id} values={board.metadata} onCommit={(name, value) => fields.mutate({ [name]: value })} /><ContributedDetailPanels target="builds:inspection" ctx={{ slug, entityId: id, entityTitle: board.serial_code || `Board ${board.ordinal}` }} /><button className={inspectionButton} disabled={label.isPending} onClick={() => label.mutate()}>Queue board QR label</button>{board.history.length > 0 && <details><summary className="min-h-11">Earlier decisions and rework</summary>{board.history.map((entry, i) => <article className="rounded border border-line p-3 space-y-2" key={i}><p>Decision {i + 1}: {String(entry.status)} · {String(entry.inspected_at ?? "")}</p><p className="whitespace-pre-wrap">{String(entry.notes ?? "")}</p>{typeof entry.front_file_id === "string" && typeof entry.back_file_id === "string" && <InspectionPhotos slug={slug} front={entry.front_file_id} back={entry.back_file_id} />}</article>)}</details>}</>}{message && <p role="status">{message}</p>}</main>;
}
