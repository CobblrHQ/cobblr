// Inline printer config, opened from the labels-page printer chip.
//
// WHAT THIS OWNS, and why it is so short: the toolbar already picks the label
// size, and bleSettingsForSize OVERRIDES the printer's stored media geometry from
// that pick on every print. So the size fields this modal used to show were not
// merely a duplicate of the toolbar — they were INERT. You could set "loaded label
// 40x30" here and it changed nothing about what printed. A control that looks
// authoritative and does nothing is worse than no control (the author, 2026-07:
// "redundant and worse").
//
// So this owns exactly the settings the toolbar CANNOT know, which are the ones
// bleSettingsForSize deliberately keeps from the printer: how the print sits on
// the label (top margin), how dark it burns (density), and the printer's name.
// The size is shown read-only, sourced from the same pick the toolbar uses, so the
// modal tells the truth about what will print without pretending to set it.
//
// Bluetooth only (a network printer's config is the manager URL, which belongs on
// the printers page); dialect, orientation and calibration stay one link away.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Modal, useToast } from "@cobblr/platform-web";
import { useLabels } from "./context";

const DOTS_PER_MM = 8; // 203 dpi

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
  loadedSizeLabel,
}: {
  printer: PrinterLite;
  open: boolean;
  onClose: () => void;
  /** The size the TOOLBAR is set to — the one that will actually print. Shown
   *  read-only so this modal cannot disagree with what comes out. */
  loadedSizeLabel?: string;
}) {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const s0 = (printer.settings ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(printer.name);
  // Print position in mm, not dots: nobody thinks in dots, and the reason this
  // control exists at all is the physical complaint "it prints too low".
  const [topMm, setTopMm] = useState(String(Number(((Number(s0.topMarginDots) || 0) / DOTS_PER_MM).toFixed(1))));
  const [density, setDensity] = useState(String(Number(s0.density) || 8));

  const topMmN = Math.max(0, Number(topMm) || 0);
  const densityN = Math.max(1, Math.min(15, Math.round(Number(density) || 8)));

  const save = useMutation({
    mutationFn: () => {
      const settings = { ...s0, topMarginDots: Math.round(topMmN * DOTS_PER_MM), density: densityN };
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
  const canSave = !!name.trim();

  return (
    <Modal open={open} onClose={onClose} title="Printer" subtitle={printer.name}>
      <div className="space-y-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">name</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {loadedSizeLabel && (
          <div>
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">printing</span>
            <div className="mt-1 text-sm text-content dark:text-mortar-100">{loadedSizeLabel}</div>
            <div className="text-[11px] text-faint dark:text-slate-500 mt-0.5">
              Set by the label picker on this page, so it always matches what prints.
            </div>
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">print position</span>
          <div className="flex items-center gap-2">
            <input
              className={`${field} w-24`}
              type="number"
              step="0.5"
              min={0}
              value={topMm}
              onChange={(e) => setTopMm(e.target.value)}
              aria-label="Top margin in mm"
            />
            <span className="text-xs text-faint dark:text-slate-500">mm from the top edge</span>
          </div>
          <span className="text-[11px] text-faint dark:text-slate-500">
            Printing too low? Lower this. At 0 the label is centred; raise it only if your printer
            clips the top.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">darkness</span>
          <div className="flex items-center gap-2">
            <input
              className="w-40"
              type="range"
              min={1}
              max={15}
              value={densityN}
              onChange={(e) => setDensity(e.target.value)}
              aria-label="Print density"
            />
            <span className="text-xs text-faint dark:text-slate-500">{densityN} of 15</span>
          </div>
          <span className="text-[11px] text-faint dark:text-slate-500">
            Faint or patchy? Raise it. Smudged or bleeding? Lower it.
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
