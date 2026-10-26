import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { downloadBlob, fieldPackControlClass, headerButton, NumberField, useCan, useConfirm, useFieldDraft, usePasteImage, useToast } from "@cobblr/platform-web";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import { orderWriteKey, type SalesApi, type DocumentRow } from "./api.js";

export function OrderDocuments({ api, orderId, disabled }: { api: SalesApi; orderId: string; disabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const maySend = useCan("sales:send-document");
  const [editing, setEditing] = useState<"quote" | "invoice" | null>(null);
  const list = useQuery({ queryKey: ["sales-documents", api.workspace, orderId], queryFn: () => api.documents(orderId) });
  const documents = list.data?.items ?? [];
  const [downloading, setDownloading] = useState(false);
  const download = async (kind: "quote" | "invoice") => {
    setDownloading(true);
    try { downloadBlob(await api.documentPdf(orderId, kind), `${kind}-${orderId}.pdf`); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setDownloading(false); }
  };
  const sent = useMutation({
    mutationFn: ({ doc, to }: { doc: DocumentRow; to: string }) => api.sendDocument(orderId, doc.kind, doc.revision, to),
    onSuccess: r => { toast.success(r.status === "sent" ? `Sent to ${r.to}` : "This address cannot receive mail, so nothing was sent."); void qc.invalidateQueries({ queryKey: ["sales-order-history", orderId] }); },
    onError: e => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const open = (kind: "quote" | "invoice") => {
    if (kind === "invoice" && documents.some(d => d.kind === kind)) void download(kind);
    else setEditing(kind);
  };
  return <section aria-label="Quotes and invoices" className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <button type="button" className={headerButton()} disabled={disabled || downloading} onClick={() => open("quote")}>Quote PDF</button>
      <button type="button" className={headerButton()} disabled={disabled || downloading} onClick={() => open("invoice")}>Invoice PDF</button>
    </div>
    {list.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{String(list.error)}</p>}
    {editing && <DocumentForm key={editing} api={api} orderId={orderId} kind={editing} disabled={disabled} previous={documents.find(d => d.kind === editing)} shopName={list.data?.shop_name ?? ""} onCancel={() => setEditing(null)} onSaved={async kind => {
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["sales-documents", api.workspace, orderId] });
      await download(kind);
    }} />}
    {documents.map(doc => <div key={doc.id} className="rounded border border-line p-3 space-y-2 text-sm">
      <p className="font-medium">{doc.kind === "quote" ? "Quote" : "Invoice"} {doc.number}</p>
      <p>{doc.kind === "invoice" ? "Issued" : "Prepared"} {doc.snapshot.date}{doc.snapshot.deadline ? ` · ${doc.kind === "quote" ? "Valid until" : "Due"} ${doc.snapshot.deadline}` : ""} · {formatStoredMoney(doc.snapshot.total, "amount", { currency: doc.snapshot.currency })}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={headerButton()} disabled={downloading} onClick={() => void download(doc.kind)}>Download {doc.kind === "quote" ? "quote" : "invoice"}</button>
        {maySend && <button type="button" className={headerButton()} disabled={!list.data?.email?.available || sent.isPending} onClick={async () => {
          const to = list.data?.email?.to;
          if (!to) return;
          if (await confirm({ title: `Send ${doc.kind}?`, message: `Email ${doc.number} and its PDF to ${to} from ${list.data?.email?.from}?`, confirmLabel: `Send ${doc.kind}` })) sent.mutate({ doc, to });
        }}>Email {doc.kind === "quote" ? "quote" : "invoice"}</button>}
      </div>
      {doc.kind === "invoice" && <p className="text-xs text-muted">The issued lines and total are saved. Later changes to the order do not change this invoice.</p>}
    </div>)}
    {list.data?.email?.reason && <p className="text-xs text-muted">{list.data.email.reason}</p>}
  </section>;
}

function DocumentForm({ api, orderId, kind, disabled, previous, shopName, onCancel, onSaved }: {
  api: SalesApi; orderId: string; kind: "quote" | "invoice"; disabled: boolean; previous?: DocumentRow; shopName: string;
  onCancel: () => void; onSaved: (kind: "quote" | "invoice") => Promise<void>;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const name = useFieldDraft(previous?.snapshot.shop_name ?? shopName);
  const deadline = useFieldDraft(previous?.snapshot.deadline ?? "");
  const tax = useFieldDraft(String(previous?.snapshot.tax_rate ?? 0));
  const [logoFileId, setLogoFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const create = useMutation({
    mutationFn: () => api.prepareDocument(orderId, { kind, shop_name: name.draft, deadline: deadline.draft || null, tax_rate: Number(tax.draft), logo_file_id: logoFileId }),
    onSuccess: () => onSaved(kind),
    onError: e => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const busy = disabled || create.isPending || uploading;
  const logoArea = useRef<HTMLFormElement>(null);
  async function uploadLogo(file: File) {
    if (file.size > 1_000_000) { toast.error("Choose a logo smaller than 1 MB."); return; }
    if (!["image/png", "image/jpeg"].includes(file.type)) { toast.error("Choose a PNG or JPEG logo."); return; }
    setUploading(true);
    try { setLogoFileId((await api.uploadLogo(file)).id); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  }
  usePasteImage(logoArea, { enabled: !busy, accept: "image/png,image/jpeg", onFiles: files => { if (files[0]) void uploadLogo(files[0]); } });
  return <form ref={logoArea} className="rounded border border-line p-3 space-y-3" onSubmit={e => { e.preventDefault(); if (!busy && qc.isMutating({ mutationKey: orderWriteKey(orderId) }) === 0) create.mutate(); }}>
    <p className="font-medium text-sm">{kind === "quote" ? "Prepare quote" : "Issue invoice"}</p>
    {disabled && <p role="status" className="text-xs text-muted">Saving order changes…</p>}
    <label className="block text-sm">Shop name<input required disabled={busy} maxLength={200} aria-label="Shop name" className={fieldPackControlClass} value={name.draft} onChange={e => name.setDraft(e.target.value)} /></label>
    <label className="block text-sm">{kind === "quote" ? "Valid until" : "Invoice due date"}<input type="date" disabled={busy} aria-label={kind === "quote" ? "Valid until" : "Invoice due date"} className={fieldPackControlClass} value={deadline.draft} onChange={e => deadline.setDraft(e.target.value)} /></label>
    <label className="block text-sm">Tax (%)<NumberField disabled={busy} label="Tax (%)" min={0} max={100} className={fieldPackControlClass} value={Number(tax.draft)} onChange={value => tax.setDraft(String(value))} /></label>
    <label className="block text-sm">Shop logo (optional)<input aria-label="Shop logo" type="file" accept="image/png,image/jpeg" disabled={busy} className="block w-full min-w-0 text-sm" onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadLogo(file);
    }} /></label>
    {logoFileId && <p className="text-xs text-muted">Logo ready.</p>}
    <p className="text-xs text-muted">{kind === "quote" ? "Preparing a quote does not confirm, fulfil or mark the order paid. Preparing it again replaces this quote with the order's current lines." : "Issuing allocates an invoice number and saves the current lines, prices, tax and due date. Check the order before continuing."}</p>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy} className={headerButton("primary")}>{create.isPending ? "Preparing…" : kind === "quote" ? "Create quote" : "Issue invoice"}</button>
      <button type="button" disabled={busy} onClick={onCancel} className={headerButton()}>Cancel document</button>
    </div>
  </form>;
}
