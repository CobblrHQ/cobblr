import { useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { MoneyInput, RecordFormModal, useMoneyCurrency, usePhotoPick, useToast, NumberField } from "@cobblr/platform-web";
import { dayHere } from "@cobblr/platform-contract/day";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { api, type MaintenanceTerm, type MaintenanceTermPatch } from "../../lib/api";
import { openAuthedFile } from "../../lib/authed-file";

const input = "w-full rounded-md border border-line bg-surface px-3 py-2 text-base";
const date = (v: string | null) => v ? new Date(v.slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Date unknown";
export function TermHistory({ slug, entityId, refresh }: { slug: string; entityId: string; refresh: () => void }) {
  const [editing, setEditing] = useState<MaintenanceTerm | null>(null);
  const query = useInfiniteQuery({ queryKey: ["maintenance-terms", slug, entityId], initialPageParam: 0,
    queryFn: ({ pageParam }) => api.listMaintenanceTerms(slug, entityId, pageParam),
    getNextPageParam: (last, pages) => last.has_more ? pages.reduce((n, p) => n + p.items.length, 0) : undefined });
  const terms = query.data?.pages.flatMap((p) => p.items) ?? [];
  const totals = query.data?.pages[0]?.totals;
  return <section className="space-y-3" aria-label="Terms">
    <h3 className="text-sm font-semibold">Terms</h3>
    {query.isLoading && <p className="text-sm text-muted">Loading terms</p>}
    {query.isError && <p role="alert" className="text-sm">Couldn't load terms.</p>}
    {!query.isLoading && !query.isError && !terms.length && <p className="text-sm text-muted">No paid terms yet.</p>}
    {terms.map((t) => <article key={t.id} className="rounded-lg border border-line p-3 space-y-2" data-testid="renewal-term">
      <div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-medium">{t.name}</p><button type="button" className="text-sm text-accent" onClick={() => setEditing(t)}>Edit term</button></div>
      <p className="text-sm">{date(t.term_start)} to {date(t.term_end)}{t.term_start && t.term_end && t.term_start.slice(0, 10) <= dayHere() && t.term_end.slice(0, 10) > dayHere() ? " · Current term" : ""}</p>
      <p className="text-sm">{t.cost_cents == null || !Object.hasOwn(t, "currency") ? "Cost unknown" : formatStoredMoney(t.cost_cents, "cents", { currency: t.currency })}{t.quantity != null ? ` · ${t.quantity} seats or units` : ""}</p>
      {t.reference && <p className="text-sm break-words">Reference: {t.reference}</p>}
      {t.renewed_by && <p className="text-xs text-muted">Renewed by {t.renewed_by}</p>}
      {t.attachments?.map((f) => <button type="button" key={f.fileId} className="block max-w-full break-all text-sm text-accent underline" onClick={() => { void openAuthedFile(slug, f.fileId, { filename: f.filename }); }}>{f.filename}</button>)}
    </article>)}
    {query.hasNextPage && <button type="button" className="text-sm text-accent" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>Older terms</button>}
    {!!totals?.lifetime.length && <div className="space-y-1 text-sm" aria-label="Term totals">
      <p>Lifetime cost: {totals.lifetime.map((r) => formatStoredMoney(r.cost_cents, "cents", { currency: r.currency })).join(" + ")}</p>
      {totals.per_year.map((r) => <p key={`${r.year}-${r.currency}`}>Cost in {r.year}: {formatStoredMoney(r.cost_cents, "cents", { currency: r.currency })}</p>)}
    </div>}
    {editing && <TermEditor slug={slug} term={editing} close={() => setEditing(null)} refresh={refresh} />}
  </section>;
}
function TermEditor({ slug, term, close, refresh }: { slug: string; term: MaintenanceTerm; close: () => void; refresh: () => void }) {
  const main = useMoneyCurrency(); const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const photo = usePhotoPick((files) => setFile(files[0] ?? null), { title: "Term document", label: "Choose document photo" });
  const moneyHidden = !Object.hasOwn(term, "cost_cents") || !Object.hasOwn(term, "currency");
  const [draft, setDraft] = useState<MaintenanceTermPatch>({ term_start: term.term_start?.slice(0, 10), term_end: term.term_end?.slice(0, 10),
    cost_cents: moneyHidden ? undefined : term.cost_cents, currency: Object.hasOwn(term, "currency") ? term.currency ?? main : undefined, reference: term.reference, quantity: term.quantity });
  const save = useMutation({ mutationFn: async () => {
    const uploaded = file ? await api.uploadFile(slug, file) : null;
    return api.updateMaintenanceTerm(slug, term.id, { ...draft, ...(uploaded ? { file_id: uploaded.id } : {}) });
  }, onSuccess: () => { refresh(); close(); }, onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save term") });
  return <RecordFormModal open onClose={close} title="Edit term"><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    <label className="block text-sm">Term start<input aria-label="Term start" className={input} type="date" value={draft.term_start ?? ""} onChange={(e) => setDraft({ ...draft, term_start: e.target.value || undefined })} /></label>
    <label className="block text-sm">Term end<input aria-label="Term end" className={input} type="date" value={draft.term_end ?? ""} onChange={(e) => setDraft({ ...draft, term_end: e.target.value || undefined })} /></label>
    <MoneyInput value={draft["cost_cents"]} storage="cents" currency={draft.currency} onCurrencyChange={(currency) => setDraft({ ...draft, currency })} ariaLabel="Cost" live onCommit={(value) => setDraft({ ...draft, cost_cents: value, ...(value != null ? { currency: draft.currency ?? main } : {}) })} />
    <TermReferenceQuantity reference={draft.reference ?? ""} quantity={draft.quantity ?? null} onReference={(reference) => setDraft({ ...draft, reference })} onQuantity={(quantity) => setDraft({ ...draft, quantity })} />
    <div className="space-y-2 text-sm"><button type="button" className="text-accent" onClick={photo.pick}>Add photo</button>{photo.input}
      <label className="block">Add document<input className="block w-full min-w-0" type="file" accept="image/*,application/pdf" aria-label="Add document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      {file && <p className="break-all">{file.name}</p>}
    </div>
    <div className="flex gap-3"><button className="rounded-md bg-accent px-3 py-2 text-sm text-white" type="submit" disabled={save.isPending}>Save</button><button type="button" onClick={close}>Cancel</button></div>
  </form></RecordFormModal>;
}
export function TermReferenceQuantity({ reference, quantity, onReference, onQuantity }: { reference: string; quantity: number | null; onReference: (v: string) => void; onQuantity: (v: number | null) => void }) {
  return <>
    <label className="block text-sm">PO or invoice reference<input className={input} aria-label="PO or invoice reference" maxLength={200} value={reference} onChange={(e) => onReference(e.target.value)} /></label>
    <label className="block text-sm">Seats or quantity<NumberField className={input} label="Seats or quantity" min={0.000001} value={quantity} onChange={onQuantity} onClear={() => onQuantity(null)} /></label>
  </>;
}
