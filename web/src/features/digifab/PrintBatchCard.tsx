import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto, NumberField, useToast } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { api, ApiError, type MakePrintBatch, type MakeStepRecord } from "../../lib/api";

import { countOf } from "@cobblr/platform-contract/plural";
type CardRow = Pick<MakeStepRecord, "status" | "data" | "error">;
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The batch could not be updated.";

export function PrintBatchCard({ makeId, row }: { makeId: string; row: CardRow }) {
  const { activeSlug: slug, activeOrg } = useActiveOrg();
  const queryClient = useQueryClient();
  const toast = useToast();
  const batch = row.data.batch as MakePrintBatch;
  const data = row.data as { printer?: string; spool?: string; slot?: string; grams?: number; time_s?: number; preview_file_id?: string };
  const canStart = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  const canCancel = roleSatisfies(activeOrg?.role, ["owner", "admin", "member"]);
  const fullReview = batch.state === "review" || batch.state === "needs_approval";
  const ended = ["complete", "cancelled", "failed"].includes(batch.state);
  const [error, setError] = useState("");
  const [quantity, setQuantity] = useState(batch.quantity);
  useEffect(() => setQuantity(batch.quantity), [batch.quantity]);
  const pressed = useRef(false);
  const context = `${makeId}:${row.status}:${batch.state}:${batch.review_hash}:${batch.starts.length}`;
  useEffect(() => { pressed.current = false; setError(""); }, [context]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["makes", slug] }),
      queryClient.invalidateQueries({ queryKey: ["print-batches", slug] }),
      queryClient.invalidateQueries({ queryKey: ["digifab-fleet", slug] }),
    ]);
  };
  const start = useMutation({
    mutationFn: () => fullReview && !batch.settled.length ? api.startMakePrint(slug, makeId, batch.review_hash) : api.startNextMakePrint(slug, makeId, fullReview ? batch.review_hash : undefined),
    onSuccess: () => toast.success(`Started on ${data.printer || "the printer"}`),
    onError: error => { pressed.current = false; setError(errorMessage(error)); },
    onSettled: refresh,
  });
  const cancel = useMutation({ mutationFn: () => api.cancelMakePrintBatch(slug, makeId), onSuccess: () => toast.success("Remaining prints cancelled"), onError: error => setError(errorMessage(error)), onSettled: refresh });
  const review = useMutation({ mutationFn: () => api.reviewMakePrintBatch(slug, makeId, quantity), onError: error => setError(errorMessage(error)), onSettled: refresh });
  const press = () => { if (pressed.current) return; pressed.current = true; setError(""); start.mutate(); };
  const spools = (batch.facts.spools ?? []) as Array<{ id: string; name?: string; slot?: string; material?: { material?: string; color_hex?: string } }>;
  return <section data-testid="print-batch-card" className="rounded border border-accent/40 bg-subtle p-3 space-y-3 break-words">
    <p className="font-semibold">{batch.completed} of {batch.quantity} printed</p>
    {fullReview && <>
      {data.preview_file_id && <div className="relative w-24 h-24 rounded overflow-hidden border border-line"><EntityPhoto src={api.fileRawUrl(slug, data.preview_file_id, "medium")} alt="Slice preview" fill fit="contain" /></div>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {data.printer && <><dt className="text-muted">Printer</dt><dd>{data.printer}</dd></>}
        {typeof batch.facts.file_name === "string" && <><dt className="text-muted">Print file</dt><dd>{batch.facts.file_name}</dd></>}
        <dt className="text-muted">Batch</dt><dd>{countOf(batch.quantity, "print")}</dd>
        {typeof data.grams === "number" && <><dt className="text-muted">Filament</dt><dd>{data.grams} g each, {Math.round(data.grams * batch.quantity * 10) / 10} g total</dd></>}
        {typeof data.time_s === "number" && <><dt className="text-muted">Time</dt><dd>About {Math.round(data.time_s / 60)} min each</dd></>}
        {spools.length ? spools.map(spool => <div key={`${spool.slot}:${spool.id}`} className="contents"><dt className="text-muted">Slot {spool.slot}</dt><dd>{spool.name || "Loaded spool"}{spool.material?.material ? ` · ${spool.material.material}` : ""}{spool.material?.color_hex ? ` · ${spool.material.color_hex}` : ""}</dd></div>) : data.spool && <><dt className="text-muted">Spool</dt><dd>{data.spool}{data.slot ? `, slot ${data.slot}` : ""}</dd></>}
      </dl>
      <p className="text-sm">Approval covers this printer, files, spools and all {countOf(batch.quantity, "print")}. This physically starts {batch.completed ? "the next print" : "the first print"}. Clear the bed before pressing Start.</p>
    </>}
    {batch.state === "running" && <p className="text-sm">Print {batch.completed + 1} is starting or running.</p>}
    {batch.state === "waiting_bed" && <p className="text-sm">Remove the finished print and clear the bed. This physically starts the next print.</p>}
    {batch.state === "changed" && <p className="text-sm">The printer, file, spool, material or quantity changed. Review the batch and approve it again.</p>}
    {batch.state === "cancelled" && <p className="text-sm">Remaining prints cancelled. A print already starting or running finishes.</p>}
    {batch.state === "complete" && <p className="text-sm">Batch complete.</p>}
    {batch.state === "failed" && <p className="text-sm">The batch stopped after a failed or cancelled print.</p>}
    {(error || row.error) && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error || row.error}</p>}
    <div className="flex flex-wrap gap-2">
      {canStart && !ended && row.status === "awaiting_confirm" && (fullReview || batch.state === "waiting_bed") && <button type="button" className={`${button} bg-cobble-600 text-white`} disabled={start.isPending || quantity !== batch.quantity} onClick={press}>{start.isPending ? "Starting…" : fullReview ? batch.completed ? "Approve the batch and start the next print" : `Approve ${countOf(batch.quantity, "print")} and start` : "Bed is clear, start the next one"}</button>}
      {canStart && (batch.state === "changed" || quantity !== batch.quantity) && <button type="button" className={button} disabled={review.isPending} onClick={() => review.mutate()}>Review the batch again</button>}
      {canCancel && !ended && <button type="button" className={button} disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel the remaining prints</button>}
    </div>
    {canStart && !ended && row.status === "awaiting_confirm" && <details className="text-sm"><summary className="cursor-pointer">Change the total</summary><label className="block mt-2">Total prints including those finished<NumberField integer min={batch.completed + 1} max={10000} value={quantity} onChange={setQuantity} className="block mt-1 w-full rounded border border-line bg-surface px-2 py-1.5" /></label><p className="mt-1 text-muted">Review and approve the changed total before another print starts.</p></details>}
    {!canStart && !ended && <p className="text-sm text-muted">An owner or admin starts the next print.</p>}
    {!!batch.starts.length && <details className="text-sm"><summary className="cursor-pointer">Start history</summary><ol className="mt-2 space-y-1">{batch.starts.map((start,index) => <li key={`${start.job_id}:${index}`}>Print {start.ordinal} · {start.status} · <time dateTime={start.at}>{new Date(start.at).toLocaleString()}</time></li>)}</ol></details>}
  </section>;
}

export function MachinePrintBatches({ slug, machineId }: { slug: string; machineId: string }) {
  const query = useQuery({ queryKey: ["print-batches", slug], queryFn: () => api.listMakePrintBatches(slug), refetchInterval: 4000 });
  if (query.error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">Print batches could not be loaded: {errorMessage(query.error)}</p>;
  return <>{query.data?.items.filter(batch => batch.linked_machine_id === machineId).map(batch => <div key={batch.make_id} className="space-y-2"><Link className="underline text-sm" to={`/makes/${batch.make_id}`}>{batch.name}</Link><PrintBatchCard makeId={batch.make_id} row={batch} /></div>)}</>;
}
