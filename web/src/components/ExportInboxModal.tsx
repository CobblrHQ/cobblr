// The scan inbox EXPORT modal. Replaces the old one-tap "dump the whole inbox"
// button with a real chooser:
//   · which items (checkboxes, pre-checked from the inbox selection)
//   · how to carry photos — Link (small file, destination fetches from this
//     instance) / Baked in (self-contained, works offline / LAN-only) / None
//   · for Link, how long the per-file photo links stay valid (TTL)
// Default photo mode comes from the instance (self-host → baked in; hosted can
// set link); the user always overrides here. POST /export → blob → download.
import { useEffect, useMemo, useState } from "react";
import { Modal, useToast } from "@cobblr/platform-web";
import { getToken } from "../lib/api";

type PhotoMode = "link" | "embed" | "none";
interface TtlChoice {
  label: string;
  ms: number;
}
interface ExportItemLite {
  id: string;
  name: string;
}

const PHOTO_MODES: { key: PhotoMode; label: string; blurb: string }[] = [
  { key: "link", label: "Link", blurb: "Small file. The destination downloads each photo from this instance during import; links are scoped to just these files and expire. Won't work for an offline / LAN-only destination." },
  { key: "embed", label: "Baked in", blurb: "Images embedded in the export file. Bigger, but fully self-contained: no public links, works offline / LAN-only / air-gapped." },
  { key: "none", label: "None", blurb: "Metadata only. No photos travel with the export." },
];

export function ExportInboxModal({
  slug,
  items,
  preselectedIds,
  onClose,
}: {
  slug: string;
  items: ExportItemLite[];
  preselectedIds: string[];
  onClose: () => void;
}) {
  const toast = useToast();
  // Pre-check the inbox's current selection; if nothing was checked, all.
  const [checked, setChecked] = useState<Set<string>>(() =>
    preselectedIds.length ? new Set(preselectedIds) : new Set(items.map((i) => i.id)),
  );
  const [photoMode, setPhotoMode] = useState<PhotoMode>("embed");
  const [ttlChoices, setTtlChoices] = useState<TtlChoice[]>([]);
  const [ttlMs, setTtlMs] = useState<number>(24 * 60 * 60 * 1000);
  const [busy, setBusy] = useState(false);

  // Instance defaults (photo mode + TTL options) for the chooser.
  useEffect(() => {
    let live = true;
    void fetch(`/api/v1/orgs/${slug}/modules/core-scan/export/options`, {
      headers: { Authorization: `Bearer ${getToken() ?? ""}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!live || !cfg) return;
        if (cfg.default_photo_mode) setPhotoMode(cfg.default_photo_mode as PhotoMode);
        if (Array.isArray(cfg.ttl_choices)) setTtlChoices(cfg.ttl_choices as TtlChoice[]);
        if (typeof cfg.default_ttl_ms === "number") setTtlMs(cfg.default_ttl_ms);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [slug]);

  const allChecked = checked.size === items.length && items.length > 0;
  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(items.map((i) => i.id)));

  const selectedIds = useMemo(() => items.filter((i) => checked.has(i.id)).map((i) => i.id), [items, checked]);

  async function runExport() {
    if (!selectedIds.length) {
      toast.error("Pick at least one item to export");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/orgs/${slug}/modules/core-scan/export`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: selectedIds,
          photo_mode: photoMode,
          ...(photoMode === "link" ? { ttl_ms: ttlMs } : {}),
        }),
      });
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cobblr-scan-selection-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${selectedIds.length} item${selectedIds.length === 1 ? "" : "s"} — import it via ‘Import’`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Export inbox" size="md">
      <div className="space-y-4">
        {/* Item selection */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="text-muted">
              {selectedIds.length} of {items.length} item{items.length === 1 ? "" : "s"} selected
            </span>
            <button type="button" onClick={toggleAll} className="text-accent hover:underline">
              {allChecked ? "Select none" : "Select all"}
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto rounded border border-line dark:border-slate-700 divide-y divide-line dark:divide-slate-800">
            {items.map((it) => (
              <label key={it.id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm cursor-pointer hover:bg-subtle dark:hover:bg-slate-800/60">
                <input
                  type="checkbox"
                  checked={checked.has(it.id)}
                  onChange={() => toggle(it.id)}
                  className="h-3.5 w-3.5 accent-cobble-600 shrink-0"
                />
                <span className="truncate text-content dark:text-mortar-100">{it.name || "(unnamed)"}</span>
              </label>
            ))}
            {items.length === 0 && <div className="px-2.5 py-3 text-sm text-faint">Nothing in the inbox to export.</div>}
          </div>
        </div>

        {/* Photo mode */}
        <div>
          <div className="mb-1.5 text-sm font-medium text-content dark:text-mortar-100">Photos</div>
          <div className="flex gap-2">
            {PHOTO_MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setPhotoMode(m.key)}
                className={
                  "flex-1 rounded border px-2.5 py-1.5 text-sm transition " +
                  (photoMode === m.key
                    ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 text-accent font-medium"
                    : "border-line dark:border-slate-700 text-muted hover:bg-subtle dark:hover:bg-slate-800/60")
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">{PHOTO_MODES.find((m) => m.key === photoMode)?.blurb}</p>
          {/* TTL only matters for Link mode */}
          {photoMode === "link" && ttlChoices.length > 0 && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="text-muted">Links expire in</span>
              <select
                value={ttlMs}
                onChange={(e) => setTtlMs(Number(e.target.value))}
                className="rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-800 px-2 py-1 text-content dark:text-mortar-100"
              >
                {ttlChoices.map((c) => (
                  <option key={c.ms} value={c.ms}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void runExport()}
            disabled={busy || selectedIds.length === 0}
            className="rounded bg-cobble-600 hover:bg-cobble-700 px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50"
          >
            {busy ? "Exporting…" : `Export ${selectedIds.length || ""}`.trim()}
          </button>
        </div>
      </div>
    </Modal>
  );
}
