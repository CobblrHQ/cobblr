// Configure accumulate-then-print (slice 2, D5/D6). A per-user policy: which
// printer + label size the queue auto-fires to, and when (a full sheet / every N /
// each label). Server-side, so CUPS or edge printers only — a browser-Bluetooth
// printer can't be reached by the server (that path stays the manual Print button).
// See docs/design-decisions/label-media-and-accumulation.md.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { LABEL_SIZES } from "../label-sizes";
import type { FireMode } from "./api";
import { useLabels } from "./context";

const MODE_LABEL: Record<Exclude<FireMode, "manual">, string> = {
  "fill-media": "When a sheet fills up",
  count: "Every N labels",
  immediate: "Each label immediately",
};

export function AutoPrintModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();
  const toast = useToast();

  const cfgQ = useQuery({ queryKey: ["labels-autoflush", orgSlug], queryFn: () => api.getAutoflush(), enabled: open });
  const printersQ = useQuery({ queryKey: ["labels-printers", orgSlug], queryFn: () => api.listPrinters(), enabled: open });
  const customQ = useQuery({ queryKey: ["labels-custom-sizes", orgSlug], queryFn: () => api.listCustomSizes(), enabled: open });

  const [enabled, setEnabled] = useState(false);
  const [printerId, setPrinterId] = useState("");
  const [sizeKey, setSizeKey] = useState("");
  const [mode, setMode] = useState<Exclude<FireMode, "manual">>("count");
  const [count, setCount] = useState("2");
  const [seeded, setSeeded] = useState(false);

  // Seed the form from the loaded policy, once.
  if (open && cfgQ.data && !seeded) {
    setEnabled(cfgQ.data.enabled);
    setPrinterId(cfgQ.data.printer_id ?? "");
    setSizeKey(cfgQ.data.size_key ?? "");
    setMode(cfgQ.data.fire_mode === "manual" ? "count" : cfgQ.data.fire_mode);
    setCount(String(cfgQ.data.fire_count ?? 2));
    setSeeded(true);
  }

  // Server-side dispatch can't reach a browser-held Bluetooth printer.
  const printers = (printersQ.data?.items ?? []).filter((p) => p.driver !== "browser-bluetooth");
  const customSizes = customQ.data?.items ?? [];

  const save = useMutation({
    mutationFn: () =>
      api.setAutoflush({
        enabled,
        printer_id: enabled ? printerId || null : null,
        size_key: enabled ? sizeKey || null : null,
        fire_mode: enabled ? mode : "manual",
        fire_count: Number(count) || 2,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["labels-autoflush", orgSlug] });
      toast.success(enabled ? "Auto-print is on" : "Auto-print is off");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const canSave = !enabled || (!!printerId && !!sizeKey);
  const sel = "input !py-1.5 text-sm";

  return (
    <Modal open={open} onClose={onClose} title="Auto-print labels">
      <div className="space-y-4">
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="text-sm font-medium text-content dark:text-mortar-100">Print labels automatically as they are added</span>
            <span className="block text-xs text-faint dark:text-slate-400">Scan or add a label and it prints itself, no trip to this page. Off = you print here by hand.</span>
          </span>
        </label>

        {enabled && (
          <div className="space-y-3 pl-6">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">printer</span>
              <select className={sel} value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
                <option value="">Choose a printer…</option>
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.is_default ? " (default)" : ""}</option>
                ))}
              </select>
              {printers.length === 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">No network printer yet. Add a CUPS or edge printer under Configuration → Printers. (A Bluetooth printer prints from the browser, not automatically.)</span>
              )}
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">label size</span>
              <select className={sel} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
                <option value="">Choose a size…</option>
                <optgroup label="Built-in">
                  {LABEL_SIZES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </optgroup>
                {customSizes.length > 0 && (
                  <optgroup label="Your sizes">
                    {customSizes.map((c) => (
                      <option key={c.id} value={`custom:${c.id}`}>{c.name} ({c.per_sheet} up)</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">print when</span>
              <select className={sel} value={mode} onChange={(e) => setMode(e.target.value as Exclude<FireMode, "manual">)}>
                {(Object.keys(MODE_LABEL) as Array<keyof typeof MODE_LABEL>).map((m) => (
                  <option key={m} value={m}>{MODE_LABEL[m]}</option>
                ))}
              </select>
            </label>

            {mode === "count" && (
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">every</span>
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(e.target.value)} className={`${sel} w-20`} />
                  <span className="text-sm text-faint dark:text-slate-400">labels</span>
                </div>
              </label>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm border border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
