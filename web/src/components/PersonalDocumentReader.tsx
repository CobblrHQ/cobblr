import { useRef, useState } from "react";
import { usePasteImage } from "@cobblr/platform-web";
import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function PersonalDocumentReader() {
  const { activeSlug } = useActiveOrg();
  const [read, setRead] = useState<PersonalDocumentRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const area = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  async function readDocument(file: File) {
    if (busy || !area.current?.open) return;
    const current = ++generation.current;
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
    if (!event.currentTarget.open) { generation.current++; setRead(null); setError(""); setBusy(false); }
  }} className="rounded-xl border border-line bg-surface p-3">
    <summary className="cursor-pointer font-medium">Personal documents</summary>
    <p className="mt-2 text-sm text-muted">Read a registration, insurance or other personal document here. It never goes to a cloud AI. Values stay on this screen until you close it.</p>
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
      <button type="button" className="text-sm underline" onClick={() => setRead(null)}>Clear these values</button>
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
