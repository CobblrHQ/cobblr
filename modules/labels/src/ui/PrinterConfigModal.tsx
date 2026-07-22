// Inline printer config, opened from the labels-page printer chip — so a user
// tunes the loaded media + "labels across" (and the name) RIGHT on the labels
// page, instead of being bounced to Configuration. Bluetooth only (a network
// printer's config is the manager URL, which belongs on the printers page); the
// full field set (dialect, orientation, calibration) is one link away.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Modal, useToast } from "@cobblr/platform-web";
import { printerCapability, presetsForPrinter } from "../label-sizes.js";
import type { CustomLabelSize } from "./api";
import { useLabels } from "./context";

// mm -> dots at 203 dpi (PHOMEMO_DPI); kept inline so the labels module needn't
// depend on thermal-print. The server re-validates the resulting settings.
const mmToDots = (mm: number) => Math.round((mm / 25.4) * 203);

interface PrinterLite {
  id: string;
  name: string;
  driver: string;
  settings?: Record<string, unknown>;
}

export function PrinterConfigModal({
  printer,
  open,
  onClose,
  otherPrinters = [],
  customSizes = [],
}: {
  printer: PrinterLite;
  open: boolean;
  onClose: () => void;
  /** Every OTHER printer, so we can offer "you've done this before" layouts. */
  otherPrinters?: PrinterLite[];
  /** The workspace's custom label sizes, offered as presets too. */
  customSizes?: CustomLabelSize[];
}) {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const s0 = (printer.settings ?? {}) as Record<string, unknown>;
  const m0 = (s0.media ?? null) as { widthMm?: number; heightMm?: number; feed?: string; gapMm?: number } | null;
  const l0 = (s0.label ?? null) as { widthMm?: number } | null;
  const initW = m0?.widthMm ?? Number((Number(s0.widthDots ?? 320) / 8).toFixed(1));
  const initH = m0?.heightMm ?? Number(s0.labelHeightMm ?? 30);
  const initAcross = m0?.widthMm && l0?.widthMm ? Math.max(1, Math.round(m0.widthMm / l0.widthMm)) : 1;

  const [name, setName] = useState(printer.name);
  const [w, setW] = useState(String(initW));
  const [h, setH] = useState(String(initH));
  const [across, setAcross] = useState(String(initAcross));

  const wN = Number(w) || 0;
  const acrossN = Math.max(1, Math.min(8, Math.round(Number(across) || 1)));
  const faceW = wN / acrossN;

  // One-tap presets for the loaded media, DERIVED from what this workspace already
  // uses — layouts on other printers, its own custom sizes, then the platform's
  // fitting library — not a hardcoded catalog. Typing 50×30 every time is the
  // friction this removes; a tap sets width, height, and labels-across at once.
  const cap = printerCapability(printer.driver, printer.settings);
  const presets = presetsForPrinter(cap, { otherPrinters, customSizes });

  const save = useMutation({
    mutationFn: () => {
      const hN = Number(h) || 0;
      const feed = (m0?.feed ?? ((Number(s0.gapMm) || 0) > 0 ? "die-cut" : "continuous")) as string;
      const gapMm = Number(m0?.gapMm ?? s0.gapMm ?? 0);
      const media = { widthMm: wN, heightMm: hN, feed, gapMm };
      const label = { widthMm: acrossN > 1 ? Number(faceW.toFixed(2)) : wN, heightMm: hN };
      const settings = { ...s0, widthDots: mmToDots(wN), labelHeightMm: hN, gapMm, media, label };
      return api.updatePrinter(printer.id, { name: name.trim() || undefined, settings });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["labels-printers", orgSlug] });
      toast.success("Printer saved");
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const field = "input !py-1.5 text-sm";
  const canSave = wN >= 1 && (Number(h) || 0) >= 1 && !!name.trim();

  return (
    <Modal open={open} onClose={onClose} title="Printer" subtitle={printer.name}>
      <div className="space-y-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">name</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {presets.length > 0 && (
          <div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">sizes you&rsquo;ve used</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {presets.map((p) => {
                const active = wN === p.w && (Number(h) || 0) === p.h && acrossN === p.across;
                return (
                  <button
                    key={p.key}
                    type="button"
                    title={p.from ? `${p.w}×${p.h}mm — from ${p.from}` : `${p.w}×${p.h}mm`}
                    onClick={() => { setW(String(p.w)); setH(String(p.h)); setAcross(String(p.across)); }}
                    className={
                      "px-2 py-1 rounded-md border text-xs transition " +
                      (active
                        ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 text-accent"
                        : "border-line dark:border-slate-700 hover:border-accent hover:text-accent")
                    }
                  >
                    {p.w}×{p.h}mm{p.across > 1 ? ` · ${p.across}-up` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">loaded label (mm)</span>
          <div className="flex items-center gap-2 mt-1">
            <input className={`${field} w-24`} type="number" step="0.1" min={1} value={w} onChange={(e) => setW(e.target.value)} aria-label="Label width mm" />
            <span className="text-faint">×</span>
            <input className={`${field} w-24`} type="number" step="0.1" min={1} value={h} onChange={(e) => setH(e.target.value)} aria-label="Label height mm" />
            <span className="text-xs text-faint dark:text-slate-500">width × height</span>
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">labels across</span>
          <input className={`${field} w-24`} type="number" min={1} max={8} value={across} onChange={(e) => setAcross(e.target.value)} />
          <span className="text-xs text-faint dark:text-slate-500">
            {acrossN > 1 ? `${acrossN} labels of ${Number(faceW.toFixed(1))}mm across the ${wN || "?"}mm label` : "one label at a time"}
          </span>
        </label>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={() => { onClose(); navigate("/configuration/print"); }}
            className="text-xs text-faint dark:text-slate-400 hover:text-accent hover:underline"
            title="Dialect, orientation, calibration, and other printers"
          >
            Full settings →
          </button>
          <div className="flex gap-2">
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
      </div>
    </Modal>
  );
}
