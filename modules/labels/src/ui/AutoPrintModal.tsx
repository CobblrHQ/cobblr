// Configure accumulate-then-print (slice 2 D5/D6, slice 3c). A per-user policy:
// which printer + label size the queue auto-fires to, and when (a full sheet /
// every N / each label). A network printer (CUPS/edge) fires server-side; a
// browser-Bluetooth printer the server can't reach fires from the browser instead
// (client_fired) — the ClientAutoflushMount loop owns it while its tab holds the
// BLE session. See docs/design-decisions/label-media-and-accumulation.md.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { printerCapability, labelSizesForPrinter, customWidthFits } from "../label-sizes";
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

  // Both printer kinds are offered; the chosen one's driver decides the path. A
  // Bluetooth printer can't be reached server-side, so its policy is client_fired
  // and fires from the browser (the ClientAutoflushMount loop).
  const printers = printersQ.data?.items ?? [];
  const selectedPrinter = printers.find((p) => p.id === printerId);
  const isBle = selectedPrinter?.driver === "browser-bluetooth" || selectedPrinter?.driver === "browser-serial";
  const customSizes = customQ.data?.items ?? [];
  // Funnel the size options to what THIS printer can run (its kind + max width),
  // so a 2" printer never lists a 4×6 and an inkjet never lists a thermal roll.
  // Empty until a printer is chosen — you pick the printer first, sizes follow.
  const cap = selectedPrinter ? printerCapability(selectedPrinter.driver, selectedPrinter.settings) : null;
  const sizeOptions = cap ? labelSizesForPrinter(cap) : [];
  const customOptions = cap ? customSizes.filter((c) => customWidthFits(c.media_w, cap)) : [];

  // A Bluetooth printer prints a continuous roll — "when a sheet fills up" has no
  // meaning there, so fall back to a count.
  useEffect(() => {
    if (isBle && mode === "fill-media") setMode("count");
  }, [isBle, mode]);

  const save = useMutation({
    mutationFn: () =>
      api.setAutoflush({
        enabled,
        printer_id: enabled ? printerId || null : null,
        // A Bluetooth policy owns its media in the browser; no server size needed.
        size_key: enabled && !isBle ? sizeKey || null : null,
        fire_mode: enabled ? mode : "manual",
        fire_count: Number(count) || 2,
        client_fired: enabled && isBle,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["labels-autoflush", orgSlug] });
      toast.success(enabled ? "Auto-print is on" : "Auto-print is off");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const canSave = !enabled || (!!printerId && (isBle || !!sizeKey));
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

          {/* Always visible so you can see what auto-print needs; greyed + inert
              until you turn it on, rather than appearing out of nowhere. */}
          <div className={`space-y-3 pl-6 transition-opacity ${enabled ? "" : "opacity-50 pointer-events-none select-none"}`} aria-disabled={!enabled}>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">printer</span>
              <select className={sel} value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
                <option value="">Choose a printer…</option>
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.is_default ? " (default)" : ""}</option>
                ))}
              </select>
              {printers.length === 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">No printer yet. Add one under Configuration → Printers.</span>
              )}
              {isBle && (
                <span className="text-xs text-faint dark:text-slate-400">This printer prints from this browser tab. Auto-print fires while the tab is open and the printer is connected on the Labels page.</span>
              )}
            </label>

            {!isBle && (
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">label size</span>
                <select className={sel} value={sizeKey} onChange={(e) => setSizeKey(e.target.value)}>
                  <option value="">Choose a size…</option>
                  <optgroup label="Built-in">
                    {sizeOptions.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </optgroup>
                  {customOptions.length > 0 && (
                    <optgroup label="Your sizes">
                      {customOptions.map((c) => (
                        <option key={c.id} value={`custom:${c.id}`}>{c.name} ({c.per_sheet} up)</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">print when</span>
              <select className={sel} value={mode} onChange={(e) => setMode(e.target.value as Exclude<FireMode, "manual">)}>
                {(Object.keys(MODE_LABEL) as Array<keyof typeof MODE_LABEL>)
                  .filter((m) => !(isBle && m === "fill-media"))
                  .map((m) => (
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
