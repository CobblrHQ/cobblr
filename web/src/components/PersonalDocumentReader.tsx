import { useRef, useState } from "react";
import { Modal, raisePersonalDocument, usePasteImage } from "@cobblr/platform-web";
import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { api, ApiError, type BillOfSaleFiled } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** "Read a personal document" (the scan inbox's ⋯ menu, and the Vault's main
 *  action): choose or paste a registration, a bill of sale, insurance or
 *  another personal document, and its card opens on the personal path, the
 *  same sheet an upload of one opens (PersonalDocumentSheet). The inbox kept
 *  this as a box at its top once, above the counts on every visit; the owner
 *  asked why (2026-10-12), and the inbox's own doors take a personal document
 *  there by themselves. Closing before a read finishes drops what it reads. */
export function ReadPersonalDocumentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const area = useRef<HTMLDivElement>(null);
  const close = () => {
    generation.current++;
    setBusy(false);
    setError("");
    onClose();
  };
  async function readDocument(file: File) {
    if (busy || !open) return;
    const current = ++generation.current;
    setBusy(true); setError("");
    try {
      const read = await api.readPersonalDocument(activeSlug, file);
      if (current !== generation.current) return;
      setBusy(false);
      onClose();
      raisePersonalDocument({ orgSlug: activeSlug, read, file });
    }
    catch (err) {
      if (current !== generation.current) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : "This document could not be read.");
    }
  }
  usePasteImage(area, { enabled: open && !busy, accept: "application/pdf,image/*", onFiles: ([file]) => { if (file) void readDocument(file); } });
  return <Modal open={open} onClose={close} title="Read a personal document" size="sm">
    <div ref={area} className="space-y-3" data-personal-reader>
      <p className="text-sm text-muted">A registration, a bill of sale, insurance or another personal document. It is read on this machine unless this workspace's owner chose a cloud AI for personal documents, and it never goes to shared Files. Its values stay on screen until you close them. You can also paste one here.</p>
      <label className="block text-sm">Choose a PDF or photo
        <input className="mt-1 block max-w-full" type="file" accept="application/pdf,image/*" disabled={busy} onChange={async (event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) await readDocument(file);
          input.value = "";
        }} />
      </label>
      {busy && <p role="status" className="text-sm">Reading…</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  </Modal>;
}

const fieldLabels: Record<string, string> = { vin: "VIN", plate: "Plate", expires: "Expires", amount: "Amount", reference: "Reference", make: "Make", model: "Model", year: "Year" };

export function PersonalDocumentValues({ read }: { read: PersonalDocumentRead }) {
  return <>
    <p className="text-sm">{read.message}</p>
    <dl className="grid grid-cols-2 gap-2 text-sm">{Object.entries(read.fields).map(([key, value]) => <div key={key}>
      <dt className="font-medium">{fieldLabels[key] || key}</dt><dd className="break-words">{value}</dd>
      {read.sources[key as keyof typeof read.sources] === "local-ai" && <dd className="text-muted">Read by your local AI. Please check.</dd>}
      {read.sources[key as keyof typeof read.sources] === "cloud-ai" && <dd className="text-muted">Read by the cloud AI this workspace's owner chose. Please check.</dd>}
    </div>)}</dl>
  </>;
}

/** A read personal document: its values, what became of the original, and,
 *  for a bill of sale, "File this vehicle purchase". The one place the
 *  original's fate is said, so the card can never say it was not saved
 *  beside the sentence that put it in the Vault (#5835). */
export function PersonalDocumentCard({ read, file }: { read: PersonalDocumentRead; file?: File | Blob | null }) {
  const [filed, setFiled] = useState<BillOfSaleFiled | null>(null);
  return <>
    <PersonalDocumentValues read={read} />
    {!filed && <p className="text-sm text-muted">The original has not been saved. Keep your copy until you file it in the Vault.</p>}
    {read.kind === "bill-of-sale" && file && <FileBillOfSaleButton file={file} onFiled={setFiled} />}
  </>;
}

/** What filing a bill of sale did, in one sentence (#5331). */
export function filedSentence(f: BillOfSaleFiled): string {
  const where = f.read_by === "cloud-ai" && f.sent_to ? ` Read with ${f.sent_to}, as this workspace's owner chose.` : f.read_by === "local-ai" ? " Read with your local AI." : "";
  const purchase = f.purchase?.recorded ? " Its purchase, with the fees and tax, is in Purchases." : f.purchase?.purchases_off ? " Turn on Purchases to keep its purchase." : "";
  const original = f.vault?.kept ? ` The original is in your Vault, in ${f.vault.folder}; choosing the car on its inbox card lists it there too.` : f.vault ? ` The original was not kept (${f.vault.why}); keep your copy.` : " The original was not kept; keep your copy.";
  return `Filed: the vehicle is in the scan inbox, offered against a car you already have.${purchase}${where}${original}`;
}

/** "File this vehicle purchase" for a bill of sale (#5331): sends the page
 *  held in this tab to be read and filed on the server, where nothing keeps
 *  it, and says what it did. */
export function FileBillOfSaleButton({ file, onFiled }: { file: File | Blob; onFiled?: (filed: BillOfSaleFiled) => void }) {
  const { activeSlug } = useActiveOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filed, setFiled] = useState<BillOfSaleFiled | null>(null);
  // The page's VIN would not read (#5921): nothing was filed, and the
  // person types it; it files only when it passes its check digit.
  const [askVin, setAskVin] = useState(false);
  const [vin, setVin] = useState("");
  const send = async (typed?: string) => {
    setBusy(true); setError("");
    try {
      const page = file instanceof File ? file : new File([file], "bill-of-sale");
      const done = typed ? await api.fileBillOfSale(activeSlug, page, undefined, { vin: typed }) : await api.fileBillOfSale(activeSlug, page);
      setFiled(done);
      onFiled?.(done);
    }
    catch (err) {
      if (err instanceof ApiError && err.code === "vin_unreadable") setAskVin(true);
      setError(err instanceof Error ? err.message : "The bill of sale could not be filed.");
    }
    finally { setBusy(false); }
  };
  if (filed) return <p role="status" className="text-sm" data-bill-of-sale-filed>{filedSentence(filed)}</p>;
  return <div className="space-y-1">
    {!askVin && <button type="button" disabled={busy} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50" onClick={() => void send()}>{busy ? "Filing…" : "File this vehicle purchase"}</button>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {askVin && <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (vin.trim()) void send(vin.trim()); }}>
      <label className="text-sm">VIN
        <input className="mt-1 block w-56 rounded border border-line px-2 py-1 font-mono uppercase" value={vin} onChange={(e) => setVin(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} />
      </label>
      <button type="submit" disabled={busy || !vin.trim()} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50">{busy ? "Filing…" : "File with this VIN"}</button>
    </form>}
  </div>;
}
