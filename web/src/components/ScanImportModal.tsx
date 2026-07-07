// "Import from file" — bulk scan-inbox import (inbox-export interop + generic CSV).
// Flow: pick file → preview (detected columns, first 5 rows, per-row parse
// errors, a column mapper when a CSV has unmapped headers) → options
// (duplicate policy, fetch photos, dry-run) → import → summary card.
import { useState } from "react";
import { FileUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";

type Preview = Awaited<ReturnType<typeof api.scanImportPreview>>;
type Summary = Awaited<ReturnType<typeof api.scanImport>>;

// The canonical fields a CSV column can map to (mirror of the importer's
// resolver; "" = ignore this column).
const MAPPABLE = [
  "suggested_name", "barcode", "additional_barcodes", "suggested_sku", "suggested_serial_number",
  "suggested_entity_type", "category_domain", "category_sub", "ai_confidence", "ai_notes",
  "quantity", "pack_size", "pack_state", "filament_state", "scan_area", "box_state",
  "notes", "research_hint", "source_url", "identify_photo_url", "display_photo_url",
  "source_id", "status", "created_at", "updated_at",
];

export function ScanImportModal({ slug, open, onClose, onImported }: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<"skip" | "append" | "replace">("skip");
  const [fetchPhotos, setFetchPhotos] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  const reset = () => {
    setFile(null); setPreview(null); setMapping({}); setSummary(null); setBusy(false);
  };

  const runPreview = async (f: File, m?: Record<string, string>) => {
    setBusy(true);
    try {
      setPreview(await api.scanImportPreview(slug, f, m && Object.keys(m).length ? m : undefined));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't read that file.");
      setFile(null);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const s = await api.scanImport(slug, file, {
        dryRun,
        duplicatePolicy: policy,
        fetchPhotos,
        mapping: Object.keys(mapping).length ? mapping : undefined,
      });
      setSummary(s);
      if (!s.dry_run && s.imported_count > 0) onImported();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const unmapped = (preview?.columns ?? []).filter((c) => !c.field && !mapping[c.header]);

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Import scans from a file" size="lg">
      <div className="space-y-3 text-sm">
        {!file && (
          <>
            <p className="text-muted dark:text-slate-400">
              Bring a batch of scans from another system — an <strong>inbox export</strong> (JSON or CSV)
              works as-is; any other CSV works with a quick column mapping. Items land in this inbox as ordinary
              pending scans and go through Cobblr's own matching.
            </p>
            <label className="block">
              <input
                type="file"
                accept=".json,.csv,application/json,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setFile(f); void runPreview(f); }
                }}
                className="block w-full text-xs text-muted dark:text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-subtle dark:file:bg-slate-800 file:px-2.5 file:py-1.5 file:text-xs file:text-content dark:file:text-mortar-200"
              />
            </label>
          </>
        )}

        {busy && !summary && <p className="text-xs text-faint animate-pulse">Working…</p>}

        {file && preview && !summary && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted dark:text-slate-400">
              <FileUp size={13} className="text-accent" />
              <span className="font-medium text-content dark:text-mortar-100">{file.name}</span>
              <span>· {preview.count} item{preview.count === 1 ? "" : "s"}</span>
              {preview.source && <span>· from {preview.source}</span>}
              <button type="button" onClick={reset} className="ml-auto text-accent hover:underline">choose another file</button>
            </div>

            {unmapped.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-2 space-y-1.5">
                <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                  {unmapped.length} column{unmapped.length === 1 ? "" : "s"} didn't match a known field — map or ignore:
                </p>
                {unmapped.map((c) => (
                  <label key={c.header} className="flex items-center gap-2 text-xs">
                    <span className="font-mono w-40 truncate">{c.header}</span>
                    <select
                      value={mapping[c.header] ?? ""}
                      onChange={(e) => {
                        const m = { ...mapping };
                        if (e.target.value) m[c.header] = e.target.value;
                        else delete m[c.header];
                        setMapping(m);
                      }}
                      className="flex-1 px-1.5 py-0.5 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-xs"
                    >
                      <option value="">(ignore)</option>
                      {MAPPABLE.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => file && void runPreview(file, mapping)}
                  className="text-xs text-accent hover:underline"
                >
                  Re-preview with this mapping
                </button>
              </div>
            )}

            <div className="rounded border border-line dark:border-slate-700 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-faint dark:text-slate-500 text-left">
                  <tr>{["#", "name", "barcode", "kind", "qty", "area", "photo"].map((h) => <th key={h} className="px-2 py-1 font-normal">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className="border-t border-line dark:border-slate-800">
                      <td className="px-2 py-1 text-faint">{r.row}</td>
                      <td className="px-2 py-1 text-content dark:text-mortar-200 max-w-48 truncate">{r.name ?? "—"}</td>
                      <td className="px-2 py-1 font-mono">{r.barcode ?? "—"}</td>
                      <td className="px-2 py-1">{r.source_kind}</td>
                      <td className="px-2 py-1">{r.quantity}</td>
                      <td className="px-2 py-1">{r.scan_area ?? "—"}</td>
                      <td className="px-2 py-1">{r.has_photo ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.errors.length > 0 && (
              <details className="text-xs text-amber-700 dark:text-amber-400">
                <summary className="cursor-pointer">{preview.errors.length} parse warning{preview.errors.length === 1 ? "" : "s"}</summary>
                <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                  {preview.errors.slice(0, 50).map((e, i) => <li key={i}>row {e.row}{e.field ? ` · ${e.field}` : ""}: {e.message}</li>)}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <label className="flex items-center gap-1.5">
                duplicates
                <select value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)} className="px-1.5 py-0.5 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900">
                  <option value="skip">skip (default)</option>
                  <option value="replace">replace existing</option>
                  <option value="append">always create new</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={fetchPhotos} onChange={(e) => setFetchPhotos(e.target.checked)} /> fetch photos
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> dry run
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-1 border-t border-line dark:border-slate-800">
              <button type="button" onClick={() => { reset(); onClose(); }} className="px-3 py-1.5 rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
              <button
                type="button"
                disabled={busy || preview.count === 0}
                onClick={() => void runImport()}
                className="px-3 py-1.5 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
              >
                {busy ? "Importing…" : dryRun ? `Dry-run ${preview.count} items` : `Import ${preview.count} items`}
              </button>
            </div>
          </>
        )}

        {summary && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 p-3">
              <CheckCircle2 size={18} className="text-moss-600 dark:text-moss-300 shrink-0" />
              <div className="text-sm text-moss-800 dark:text-moss-200">
                {summary.dry_run ? "Dry run — nothing written. " : ""}
                <strong>{summary.imported_count}</strong> imported · <strong>{summary.skipped_count}</strong> skipped
                {summary.photos_fetched + summary.photos_failed > 0 && (
                  <> · photos: {summary.photos_fetched} fetched{summary.photos_failed > 0 ? `, ${summary.photos_failed} failed` : ""}</>
                )}
              </div>
            </div>
            {summary.errors.length > 0 && (
              <details className="text-xs text-amber-700 dark:text-amber-400" open={summary.errors.length <= 5}>
                <summary className="cursor-pointer flex items-center gap-1">
                  <AlertTriangle size={12} /> {summary.errors.length} row error{summary.errors.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                  {summary.errors.slice(0, 100).map((e, i) => <li key={i}>row {e.row}{e.field ? ` · ${e.field}` : ""}: {e.message}</li>)}
                </ul>
              </details>
            )}
            <div className="flex justify-end gap-2">
              {summary.dry_run ? (
                <button type="button" onClick={() => setSummary(null)} className="px-3 py-1.5 rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
                  Back
                </button>
              ) : null}
              <button type="button" onClick={() => { reset(); onClose(); }} className="px-3 py-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
