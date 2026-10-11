import { useRef, useState } from "react";
import { usePasteImage } from "@cobblr/platform-web";
import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { api, type BillOfSaleFiled } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PersonalDocumentReader() {
  const { activeSlug } = useActiveOrg();
  const [read, setRead] = useState<PersonalDocumentRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const area = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  // The page itself, held only in this tab, so "File this purchase" can send
  // it to be read and filed; nothing keeps it.
  const page = useRef<File | null>(null);
  async function readDocument(file: File) {
    if (busy || !area.current?.open) return;
    const current = ++generation.current;
    page.current = file;
    setBusy(true); setError(""); setRead(null);
    try {
      const result = await api.readPersonalDocument(activeSlug, file);
      if (current === generation.current) setRead(result);
    }
    catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "This document could not be read."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  usePasteImage(area, { enabled: open && !busy, accept: "application/pdf,image/*", onFiles: ([file]) => { if (file) void readDocument(file); } });
  return <details ref={area} onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) { generation.current++; page.current = null; setRead(null); setError(""); setBusy(false); }
  }} className="rounded-xl border border-line bg-surface p-3">
    <summary className="cursor-pointer font-medium">Personal documents</summary>
    <p className="mt-2 text-sm text-muted">Read a registration, a bill of sale, insurance or another personal document here. It is read on this machine unless this workspace's owner chose a cloud AI for personal documents. Values stay on this screen until you close it.</p>
    <label className="mt-3 block text-sm">Choose a PDF or photo
      <input className="mt-1 block max-w-full" type="file" accept="application/pdf,image/*" disabled={busy} onChange={async (event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (file) await readDocument(file);
        input.value = "";
      }} />
    </label>
    {busy && <p role="status" className="mt-2 text-sm">Reading locally…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    {read && <div className="mt-3 space-y-2" aria-label="Document values">
      <PersonalDocumentValues read={read} />
      {read.kind === "bill-of-sale" && page.current && <FileBillOfSaleButton key={generation.current} file={page.current} />}
      <button type="button" className="text-sm underline" onClick={() => { setRead(null); page.current = null; }}>Clear these values</button>
    </div>}
  </details>;
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
    <p className="text-sm text-muted">The original has not been saved. Keep your copy until you file it in the Vault.</p>
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
export function FileBillOfSaleButton({ file }: { file: File | Blob }) {
  const { activeSlug } = useActiveOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filed, setFiled] = useState<BillOfSaleFiled | null>(null);
  if (filed) return <p role="status" className="text-sm" data-bill-of-sale-filed>{filedSentence(filed)}</p>;
  return <div className="space-y-1">
    <button type="button" disabled={busy} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50" onClick={async () => {
      setBusy(true); setError("");
      try { setFiled(await api.fileBillOfSale(activeSlug, file instanceof File ? file : new File([file], "bill-of-sale"))); }
      catch (err) { setError(err instanceof Error ? err.message : "The bill of sale could not be filed."); }
      finally { setBusy(false); }
    }}>{busy ? "Filing…" : "File this vehicle purchase"}</button>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
