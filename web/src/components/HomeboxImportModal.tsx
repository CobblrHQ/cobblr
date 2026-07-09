// Homebox migration — upload its CSV export → PREVIEW → import. Lives in the
// Integrations page ("Migrate in from another app") as the "Homebox — CSV" card,
// beside the "Homebox — live" one-click connector (HomeboxLiveImportModal) — the
// CSV path is the no-API-access fallback (no photos). Backend: the core-import
// capability.

import { useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, Modal } from "@cobblr/platform-web";

interface Preview {
  is_homebox: boolean;
  item_count: number;
  location_count: number;
  label_count: number;
  custom_fields: string[];
  warnings: { row: number; message: string }[];
  errors: { row: number; message: string }[];
  sample: Array<{ name: string; quantity: number; location: string | null; labels: string[] }>;
}
interface Result {
  items_imported: number;
  items_failed: number;
  locations_created: number;
  errors: { row: number; message: string }[];
}

export function HomeboxImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const base = `/api/v1/orgs/${slug}/modules/core-import/homebox`;
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  const auth = (): Record<string, string> => {
    const t = getToken();
    return { "Content-Type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
  };

  async function onPick(file: File) {
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    setPreview(null);
    setResult(null);
    setBusy("preview");
    try {
      const res = await fetch(`${base}/preview`, { method: "POST", headers: auth(), body: JSON.stringify({ csv: text }) });
      const j = (await res.json()) as Preview & { error?: { message: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `preview failed (${res.status})`);
      setPreview(j);
      if (!j.is_homebox) toast.info("These columns don't look like a Homebox export — it'll still try by column name.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that file");
      setCsv(null);
      setFileName(null);
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    if (!csv) return;
    setBusy("import");
    try {
      const res = await fetch(base, { method: "POST", headers: auth(), body: JSON.stringify({ csv }) });
      const j = (await res.json()) as Result & { error?: { message: string } };
      if (!res.ok) throw new Error(j.error?.message ?? `import failed (${res.status})`);
      setResult(j);
      toast.success(`Imported ${j.items_imported} item${j.items_imported === 1 ? "" : "s"} from Homebox.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  function reset() { setFileName(null); setCsv(null); setPreview(null); setResult(null); }
  function close() { reset(); onClose(); }

  return (
    <Modal open={open} onClose={close} title="Import from Homebox" subtitle="Upload Homebox's CSV export — your items, locations and labels come across." size="lg">
      <div className="space-y-4">
        <p className="text-sm text-muted dark:text-slate-400">
          In Homebox, go to <strong>Tools → Import/Export → Export</strong> and download the CSV. Items land in <strong>Inventory</strong>,
          the location paths rebuild your <strong>Locations</strong> tree, and labels become <strong>tags</strong>. You'll preview before anything is written.
          (Photos aren't in Homebox's CSV.)
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f); e.target.value = ""; }}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 disabled:opacity-50"
          >
            <Upload size={15} /> {fileName ? "Choose a different file" : "Choose Homebox CSV"}
          </button>
          {fileName && <span className="text-sm text-muted dark:text-slate-400 font-mono truncate">{fileName}</span>}
          {busy === "preview" && <Loader2 size={16} className="animate-spin text-accent" />}
        </div>

        {preview && !result && (
          <div className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900 p-3.5 space-y-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <Stat n={preview.item_count} label="items" />
              <Stat n={preview.location_count} label="locations" />
              <Stat n={preview.label_count} label="labels" />
              {preview.custom_fields.length > 0 && <Stat n={preview.custom_fields.length} label="custom fields → details" />}
            </div>
            {preview.errors.length > 0 && (
              <div className="flex items-start gap-2 text-sm text-ember-600 dark:text-ember-400">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{preview.errors[0]!.message}</span>
              </div>
            )}
            {preview.sample.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-faint dark:text-slate-500 text-left border-b border-line dark:border-slate-700">
                      <th className="py-1.5 pr-3 font-medium">Item</th><th className="py-1.5 pr-3 font-medium">Qty</th>
                      <th className="py-1.5 pr-3 font-medium">Location</th><th className="py-1.5 pr-3 font-medium">Labels</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((it, i) => (
                      <tr key={i} className="border-b border-line/60 dark:border-slate-800">
                        <td className="py-1.5 pr-3 text-content dark:text-mortar-200">{it.name}</td>
                        <td className="py-1.5 pr-3 text-muted dark:text-slate-400">{it.quantity}</td>
                        <td className="py-1.5 pr-3 text-muted dark:text-slate-400">{it.location ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-muted dark:text-slate-400">{it.labels.join(", ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.item_count > preview.sample.length && (
                  <div className="text-[11px] text-faint dark:text-slate-500 mt-1.5">…and {preview.item_count - preview.sample.length} more.</div>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => void doImport()}
                disabled={busy !== null || preview.item_count === 0 || preview.errors.length > 0}
                className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 disabled:opacity-50"
              >
                {busy === "import" ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                {busy === "import" ? "Importing…" : `Import ${preview.item_count} item${preview.item_count === 1 ? "" : "s"}`}
              </button>
              <button type="button" onClick={reset} disabled={busy !== null} className="text-sm text-muted hover:text-content disabled:opacity-50">Clear</button>
            </div>
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-emerald-300/60 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/20 p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-content dark:text-mortar-100 font-medium">
              <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400" /> Import complete
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <Stat n={result.items_imported} label="items imported" />
              <Stat n={result.locations_created} label="locations created" />
              {result.items_failed > 0 && <Stat n={result.items_failed} label="failed" />}
            </div>
            {result.errors.length > 0 && (
              <details className="text-xs text-muted dark:text-slate-400">
                <summary className="cursor-pointer">{result.errors.length} note(s)</summary>
                <ul className="mt-1 space-y-0.5">{result.errors.slice(0, 20).map((e, i) => <li key={i}>row {e.row}: {e.message}</li>)}</ul>
              </details>
            )}
            <div className="flex items-center gap-3 pt-1">
              <a href="/inventory" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">View Inventory <ArrowRight size={14} /></a>
              <button type="button" onClick={reset} className="text-sm text-muted hover:text-content">Import another file</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="text-content dark:text-mortar-200">
      <strong className="font-semibold">{n}</strong> <span className="text-muted dark:text-slate-400">{label}</span>
    </span>
  );
}
