// CSV import — paste, preview, commit. Two-step flow:
//   1. user pastes / types CSV → "Preview" → dry-run server-side
//      returns parsed rows + detected headers
//   2. user reviews → "Import N rows" → commit server-side

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp } from "lucide-react";
import { Modal } from "@cobblr/platform-web";
import { useInventory } from "./context";
import type { ImportResponse } from "./api";
import { InventoryApiError } from "./api";

export function ImportDialog({ onClose }: { onClose: (importedCount: number) => void }) {
  const { api, itemNounPlural } = useInventory();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [defaultCat, setDefaultCat] = useState("");
  const [defaultLoc, setDefaultLoc] = useState("");
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const dryRun = useMutation({
    mutationFn: () =>
      api.importParts({
        csv,
        dry_run: true,
        default_category_id: defaultCat || null,
        default_location_id: defaultLoc || null,
      }),
    onSuccess: (r) => {
      setPreview(r);
      setError(null);
    },
    onError: (e: unknown) => {
      setError(e instanceof InventoryApiError ? e.message : "Couldn't parse CSV");
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api.importParts({
        csv,
        dry_run: false,
        default_category_id: defaultCat || null,
        default_location_id: defaultLoc || null,
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      onClose(r.committed);
    },
    onError: (e: unknown) => {
      setError(e instanceof InventoryApiError ? e.message : "Import failed");
    },
  });

  function reset() {
    setPreview(null);
    setError(null);
  }

  return (
    <Modal
      open
      onClose={() => onClose(0)}
      title={`Import ${itemNounPlural.toLowerCase()} from CSV`}
      subtitle="paste a CSV — common headers auto-detected; at minimum a name column"
      size="lg"
    >
      <div className="space-y-4">
        {!preview && (
          <>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder="name,qty,unit,cost,location&#10;M3x10 screw,200,each,0.05,Bin A1"
              rows={10}
              className="input font-mono text-xs leading-relaxed"
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Default category (if row's blank)
                </span>
                <select value={defaultCat} onChange={(e) => setDefaultCat(e.target.value)} className="input">
                  <option value="">— none —</option>
                  {cats.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                  Default location (if row's blank)
                </span>
                <select value={defaultLoc} onChange={(e) => setDefaultLoc(e.target.value)} className="input">
                  <option value="">— none —</option>
                  {locs.data?.items.map((l) => (
                    <option key={l.id} value={l.id}>
                      {"  ".repeat(l.depth)}
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {error && <div className="text-xs text-ember-500">{error}</div>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onClose(0)}
                className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:bg-slate-800/70 transition py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => dryRun.mutate()}
                disabled={!csv.trim() || dryRun.isPending}
                className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
              >
                {dryRun.isPending ? "…" : "Preview"}
              </button>
            </div>
          </>
        )}

        {preview && (
          <>
            <DetectedHeaders headers={preview.detected_headers} />
            {preview.errors.length > 0 && (
              <div className="rounded-md bg-ember-50 border border-ember-100 px-3 py-2 text-xs text-ember-600">
                <div className="flex items-center gap-1.5 font-medium mb-1">
                  <AlertTriangle size={12} /> {preview.errors.length} row{preview.errors.length === 1 ? "" : "s"} skipped
                </div>
                <ul className="space-y-0.5 font-mono">
                  {preview.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>
                      row {e.row_number}: {e.message}
                    </li>
                  ))}
                  {preview.errors.length > 5 && (
                    <li>…and {preview.errors.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}
            <div className="rounded-md border border-line dark:border-slate-700 max-h-[280px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-mortar-100 dark:bg-slate-800 sticky top-0">
                  <tr className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
                    <th className="px-2 py-1.5 text-left">#</th>
                    <th className="px-2 py-1.5 text-left">Name</th>
                    <th className="px-2 py-1.5 text-right">Qty</th>
                    <th className="px-2 py-1.5 text-left">Unit</th>
                    <th className="px-2 py-1.5 text-left">Category</th>
                    <th className="px-2 py-1.5 text-left">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row_number} className="border-t border-line dark:border-slate-700">
                      <td className="px-2 py-1 text-faint dark:text-slate-500 font-mono">{r.row_number}</td>
                      <td className="px-2 py-1 text-content dark:text-mortar-100">{r.name}</td>
                      <td className="px-2 py-1 text-right font-mono">{r.qty}</td>
                      <td className="px-2 py-1 text-muted dark:text-slate-400">{r.unit ?? "—"}</td>
                      <td className="px-2 py-1 text-muted dark:text-slate-400">{r.category_name ?? "—"}</td>
                      <td className="px-2 py-1 text-muted dark:text-slate-400">{r.location_name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <div className="text-xs text-ember-500">{error}</div>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={reset}
                className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:bg-slate-800/70 transition py-2"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => commit.mutate()}
                disabled={commit.isPending || preview.rows.length === 0}
                className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <FileUp size={14} />
                {commit.isPending ? "…" : `Import ${preview.rows.length} rows`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function DetectedHeaders({ headers }: { headers: Record<string, string | null> }) {
  const hits = Object.entries(headers).filter(([_, v]) => v !== null);
  if (hits.length === 0) return null;
  return (
    <div className="text-[10px] font-mono text-muted dark:text-slate-400 bg-mortar-100 dark:bg-slate-800 rounded-md px-3 py-2">
      <div className="text-accent mb-1">detected columns</div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
        {hits.map(([field, src]) => (
          <div key={field}>
            <span className="text-faint dark:text-slate-500">{field}:</span> {src}
          </div>
        ))}
      </div>
    </div>
  );
}
