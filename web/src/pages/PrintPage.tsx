// /configuration/print — Printers. Configure a print manager (CUPS) once, then
// any module or you can send documents to it. We hand the manager a discrete
// job; we never live-drive the device (coordinate-not-control). Direct on the
// LAN for self-hosted; the same connection rides the edge-bridge from cloud.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Printer as PrinterIcon, Wifi, Send, Pencil, Star } from "lucide-react";
import { ApiError, api, type Printer, type PrinterInput } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

/** UTF-8-safe base64 — btoa() alone throws on non-Latin1 chars (em dash, etc.). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function PrintPage() {
  usePageTitle("Printers");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Printer | "new" | null>(null);

  const list = useQuery({
    queryKey: ["printers", activeSlug],
    queryFn: () => api.listPrinters(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["printers", activeSlug] });

  const test = useMutation({
    mutationFn: (id: string) => api.testPrinter(activeSlug, id),
    onSuccess: (r) => toast[r.ok ? "success" : "error"](r.ok ? "Reachable" : `Failed: ${r.error ?? "unknown"}`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const printTest = useMutation({
    mutationFn: (id: string) =>
      api.printToPrinter(activeSlug, id, {
        document_base64: toBase64("Cobblr — core-print test page\n"),
        content_type: "text/plain",
        filename: "cobblr-test.txt",
        job_name: "cobblr-test",
      }),
    onSuccess: (r) => toast.success(`Sent — job ${r.jobId} (${r.state})`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deletePrinter(activeSlug, id),
    onSuccess: () => {
      toast.success("Printer removed");
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Printers</h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} printer{items.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add printer
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400 max-w-2xl">
        A printer is a queue on a print manager (CUPS). Cobblr sends documents to
        the manager over IPP — direct on your LAN, or via the edge-bridge from the
        cloud. It hands the manager a job; it never drives the device.
      </p>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-center text-sm text-muted dark:text-slate-400">
          No printers yet. <button onClick={() => setEditing("new")} className="text-accent hover:underline">Add one</button> — e.g. a Rollo label printer on your CUPS server.
        </div>
      )}

      <div className="grid gap-3">
        {items.map((p) => (
          <div key={p.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <PrinterIcon size={16} className="text-accent" />
              <span className="font-medium text-content dark:text-mortar-100">{p.name}</span>
              {p.is_default && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-cobble-100 dark:bg-cobble-900/30 text-accent">
                  <Star size={10} /> default
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400">
                {p.driver}
              </span>
              <div className="flex-1" />
              <button onClick={() => test.mutate(p.id)} disabled={test.isPending} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition" title="Reachability check">
                <Wifi size={13} /> Test
              </button>
              <button onClick={() => printTest.mutate(p.id)} disabled={printTest.isPending} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2.5 py-1 text-xs transition" title="Send a test page">
                <Send size={13} /> Print test
              </button>
              <button onClick={() => setEditing(p)} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Edit">
                <Pencil size={14} />
              </button>
              <button
                onClick={async () => {
                  if (await confirm({ title: `Remove ${p.name}?`, message: "This deletes the printer connection.", confirmLabel: "Remove", destructive: true })) {
                    del.mutate(p.id);
                  }
                }}
                className="p-1.5 rounded hover:bg-ember-100 dark:hover:bg-ember-900/30 text-ember-600 transition"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-2 text-xs text-muted dark:text-slate-400 font-mono">
              {p.base_url} · queue <span className="text-content dark:text-mortar-200">{p.queue}</span>
              {p.has_credentials && " · 🔒 auth set"}
            </div>
            {p.notes && <div className="mt-1 text-xs text-muted dark:text-slate-400">{p.notes}</div>}
          </div>
        ))}
      </div>

      {editing && (
        <PrinterModal
          slug={activeSlug}
          printer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void invalidate();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function PrinterModal({
  slug,
  printer,
  onClose,
  onSaved,
}: {
  slug: string;
  printer: Printer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(printer?.name ?? "");
  const [driver, setDriver] = useState(printer?.driver ?? "cups");
  const [baseUrl, setBaseUrl] = useState(printer?.base_url ?? "");
  const [queue, setQueue] = useState(printer?.queue ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isDefault, setIsDefault] = useState(printer?.is_default ?? false);
  const [notes, setNotes] = useState(printer?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || !baseUrl.trim() || !queue.trim()) {
      toast.error("Name, base URL, and queue are required");
      return;
    }
    setBusy(true);
    const creds = username || password ? { username: username || undefined, password: password || undefined } : undefined;
    const body: PrinterInput = {
      name: name.trim(),
      driver,
      base_url: baseUrl.trim(),
      queue: queue.trim(),
      is_default: isDefault,
      notes: notes.trim() || undefined,
      ...(creds ? { credentials: creds } : {}),
    };
    try {
      if (printer) await api.updatePrinter(slug, printer.id, body);
      else await api.createPrinter(slug, body);
      toast.success(printer ? "Printer saved" : "Printer added");
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

  return (
    <Modal open onClose={onClose} title={printer ? `Edit ${printer.name}` : "Add printer"}>
      <div className="space-y-3">
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rollo (shop)" autoFocus />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Driver</div>
          <select className={field} value={driver} onChange={(e) => setDriver(e.target.value)}>
            <option value="cups">CUPS (IPP)</option>
            <option value="mock">Mock (test)</option>
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Print manager URL</div>
          <input className={field + " font-mono"} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://printhost.lan:631" />
          <div className="text-[11px] text-faint mt-1">CUPS host on your LAN, or the edge-bridge URL from cloud.</div>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Queue / printer name</div>
          <input className={field + " font-mono"} value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="Rollo" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="text-xs text-muted mb-1">Username (optional)</div>
            <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="block">
            <div className="text-xs text-muted mb-1">Password (optional)</div>
            <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={printer?.has_credentials ? "•••• (unchanged)" : ""} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default printer
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Notes (optional)</div>
          <input className={field} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-600 hover:border-accent transition">Cancel</button>
          <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white transition disabled:opacity-50">
            {busy ? "Saving…" : printer ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
