// Locations CSV import — paste/upload → choose the match column → PREVIEW the
// exact create/update/skip diff (and any unresolved parents) → Import. Nothing
// writes until you click Import; Preview is a server-side dry run.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp } from "lucide-react";
import { Modal, useToast } from "@cobblr/platform-web";
import { api, ApiError, type LocationImportResponse } from "../lib/api";

// Pull the column names from the CSV's header row so the "match on" picker
// offers the actual columns (no guessing/typo'ing the id column name). Headers
// rarely contain quoted commas, so a simple split is enough for this hint.
function parseHeaders(csv: string): string[] {
  const first = csv.split(/\r?\n/).find((l) => l.trim() !== "");
  if (!first) return [];
  return first.split(",").map((h) => h.replace(/^"|"$/g, "").trim()).filter(Boolean);
}

export function ImportLocationsDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [csv, setCsv] = useState("");
  const [matchOn, setMatchOn] = useState("name");
  const [preview, setPreview] = useState<LocationImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const headers = useMemo(() => parseHeaders(csv), [csv]);
  // Keep the chosen match column valid as the CSV changes: if it isn't one of
  // the detected columns, default to "name" when present, else the first column.
  useEffect(() => {
    if (headers.length === 0) return;
    if (!headers.some((h) => h.toLowerCase() === matchOn.toLowerCase())) {
      setMatchOn(headers.find((h) => h.toLowerCase() === "name") ?? headers[0]!);
    }
  }, [headers]); // eslint-disable-line react-hooks/exhaustive-deps

  const dry = useMutation({
    mutationFn: () => api.importLocations(slug, { csv, match_on: matchOn, dry_run: true }),
    onSuccess: (r) => { setPreview(r); setError(null); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't parse the CSV"),
  });
  const commit = useMutation({
    mutationFn: () => api.importLocations(slug, { csv, match_on: matchOn, dry_run: false }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      toast.success(`Imported — ${r.created ?? 0} created, ${r.updated ?? 0} updated`);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Import failed"),
  });

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { setCsv(String(reader.result ?? "")); setPreview(null); };
    reader.readAsText(f);
  };

  const field = "px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const s = preview?.summary;

  return (
    <Modal open onClose={onClose} title="Import locations from CSV" size="lg">
      <div className="space-y-3 text-sm">
        {!preview && (
          <>
            <div className="text-xs text-muted dark:text-slate-400">
              Columns: <code>name</code> (required), <code>short_name</code>, <code>kind</code> (area/container),
              <code> parent</code> (the parent's value in the match column). Any other column is stored on the
              location's metadata as-is.
            </div>
            <label className="block">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint block mb-1">CSV</span>
              <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} rows={8} placeholder={"name,kind,parent,wos_id\nGarage,area,,12\nShelf 3,container,Garage,40"} className={field + " w-full font-mono text-xs"} />
            </label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-accent hover:underline">
                <FileUp size={13} /> Upload a .csv
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-xs">
                <span className="text-faint">Match existing on column</span>
                {headers.length > 0 ? (
                  <select value={matchOn} onChange={(e) => setMatchOn(e.target.value)} className={field + " font-mono"}>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                ) : (
                  <input value={matchOn} onChange={(e) => setMatchOn(e.target.value)} className={field + " !w-32 font-mono"} placeholder="name" />
                )}
              </label>
            </div>
            <div className="text-[11px] text-faint">
              The <b>match column</b> identifies an existing location (a row whose value already exists → update, otherwise create). Default <code>name</code>; pick your own id column (e.g. <code>wos_id</code>) to round-trip an external system. <code>parent</code> references the parent by that same column.
            </div>
          </>
        )}

        {error && <div className="text-xs text-ember-600 flex items-center gap-1"><AlertTriangle size={12} /> {error}</div>}

        {preview && (
          <>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-content dark:text-mortar-100">Matching on <code className="text-accent">{preview.match_on}</code></span>
              {s && <span className="text-faint">· {s.create} create · {s.update} update{s.unresolved_parents ? ` · ${s.unresolved_parents} unresolved parent${s.unresolved_parents === 1 ? "" : "s"}` : ""}</span>}
              <div className="flex-1" />
              <button type="button" onClick={() => setPreview(null)} className="text-faint hover:text-content">← edit CSV</button>
            </div>
            {preview.detected_headers && <div className="text-[11px] text-faint">Columns: {preview.detected_headers.map((h) => <code key={h} className="mr-1">{h}</code>)}</div>}
            {preview.errors.length > 0 && (
              <div className="text-[11px] text-ember-600">
                <AlertTriangle size={11} className="inline" /> {preview.errors.length} row{preview.errors.length === 1 ? "" : "s"} skipped: {preview.errors.slice(0, 4).map((e) => `row ${e.row_number} (${e.message})`).join("; ")}
              </div>
            )}
            <div className="border border-line dark:border-slate-700 rounded max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-faint text-[10px] uppercase tracking-wide sticky top-0 bg-subtle dark:bg-slate-800">
                  <tr><th className="text-left px-2 py-1">Action</th><th className="text-left px-2 py-1">Name</th><th className="text-left px-2 py-1">Kind</th><th className="text-left px-2 py-1">Parent</th></tr>
                </thead>
                <tbody className="divide-y divide-line dark:divide-slate-800">
                  {(preview.rows ?? []).map((r) => (
                    <tr key={r.row_number}>
                      <td className="px-2 py-1"><span className={r.action === "create" ? "text-moss-600" : "text-amber-600"}>{r.action}</span></td>
                      <td className="px-2 py-1 text-content dark:text-mortar-100">{r.name}{r.short_name ? <span className="text-faint"> · {r.short_name}</span> : null}</td>
                      <td className="px-2 py-1 text-faint">{r.kind}</td>
                      <td className="px-2 py-1">{r.parent ? <span className={r.parent.resolved ? "text-faint" : "text-ember-600"} title={r.parent.resolved ? "" : "parent not found in the file or existing"}>{r.parent.key}{r.parent.resolved ? "" : " ⚠"}</span> : <span className="text-faint/50">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-line dark:border-slate-700">
        {!preview ? (
          <button type="button" onClick={() => dry.mutate()} disabled={dry.isPending || !csv.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{dry.isPending ? "…" : "Preview"}</button>
        ) : (
          <button type="button" onClick={() => commit.mutate()} disabled={commit.isPending} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{commit.isPending ? "Importing…" : `Import ${(preview.rows ?? []).length} row${(preview.rows ?? []).length === 1 ? "" : "s"}`}</button>
        )}
        <button type="button" onClick={onClose} className="text-sm text-faint hover:text-content">Cancel</button>
      </div>
    </Modal>
  );
}
