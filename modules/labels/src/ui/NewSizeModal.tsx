// Define a label size by DIMENSIONS, with a live tile-count preview. The grid
// falls out of the numbers (deriveGrid) - "a 1.5 x 3 sheet holding two 1.5in
// squares" is two measurements, not a preset. See
// docs/design-decisions/label-media-and-accumulation.md.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, useToast } from "@cobblr/platform-web";
import { deriveGrid } from "../label-sizes";
import type { CustomLabelSize } from "./api";
import { useLabels } from "./context";

/** Cap a dimension at 2 decimals for display (1.96, not 1.9685039370078740). */
const round2 = (n: number) => Number(n.toFixed(2));
const MM_PER_IN = 25.4;
const UNIT_LS = "cobblr:label-size-unit";
type Unit = "in" | "mm";

function NumField({ label, value, onChange, step = 0.25 }: { label: string; value: string; onChange: (v: string) => void; step?: number }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">{label}</span>
      <input
        type="number" min={0} step={step} inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input !py-1 text-sm"
      />
    </label>
  );
}

export function NewSizeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (size: CustomLabelSize) => void;
}) {
  const { api, orgSlug } = useLabels();
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState("");
  // The fields hold whatever UNIT the user is working in; the stored size is always
  // inches (deriveGrid + createCustomSize speak inches). Metric label stock (50×30
  // mm) is the common case, so mm is a first-class choice, remembered per browser.
  const [unit, setUnitState] = useState<Unit>(() => (localStorage.getItem(UNIT_LS) === "mm" ? "mm" : "in"));
  const [mediaW, setMediaW] = useState("1.5");
  const [mediaH, setMediaH] = useState("3");
  const [labelW, setLabelW] = useState("1.5");
  const [labelH, setLabelH] = useState("1.5");
  const [marginL, setMarginL] = useState("0");
  const [marginT, setMarginT] = useState("0");
  const [colGap, setColGap] = useState("0");
  const [rowGap, setRowGap] = useState("0");

  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const toIn = (v: string) => (unit === "mm" ? num(v) / MM_PER_IN : num(v));
  const dims = {
    media_w: toIn(mediaW), media_h: toIn(mediaH),
    label_w: toIn(labelW), label_h: toIn(labelH),
    margin_t: toIn(marginT), margin_l: toIn(marginL),
    col_gap: toIn(colGap), row_gap: toIn(rowGap),
  };

  // Switch units in place: convert every field so the PHYSICAL size is unchanged
  // (1.5 in ⇄ 38.1 mm), rather than reinterpreting the numbers. Remembered.
  const setUnit = (u: Unit) => {
    if (u === unit) return;
    const f = u === "mm" ? MM_PER_IN : 1 / MM_PER_IN;
    const conv = (s: string) => (num(s) ? String(round2(num(s) * f)) : s);
    setMediaW(conv(mediaW)); setMediaH(conv(mediaH));
    setLabelW(conv(labelW)); setLabelH(conv(labelH));
    setMarginL(conv(marginL)); setMarginT(conv(marginT));
    setColGap(conv(colGap)); setRowGap(conv(rowGap));
    localStorage.setItem(UNIT_LS, u);
    setUnitState(u);
  };
  const u = unit === "mm" ? "mm" : "inches";
  const mainStep = unit === "mm" ? 1 : 0.25;
  const fineStep = unit === "mm" ? 0.5 : 0.125;

  // Live: how many fit, straight from the numbers.
  const grid = useMemo(
    () => deriveGrid({ paper_w: dims.media_w, paper_h: dims.media_h, ...dims }),
    [dims.media_w, dims.media_h, dims.label_w, dims.label_h, dims.margin_t, dims.margin_l, dims.col_gap, dims.row_gap],
  );
  const perSheet = grid.cols * grid.rows;
  const fits = perSheet >= 1;

  const create = useMutation({
    mutationFn: () => api.createCustomSize({ name: name.trim(), ...dims }),
    onSuccess: (size) => {
      void qc.invalidateQueries({ queryKey: ["labels-custom-sizes", orgSlug] });
      toast.success(`Added “${size.name}” (${size.per_sheet} up)`);
      onCreated(size);
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the size"),
  });

  return (
    <Modal open={open} onClose={onClose} title="New label size">
      <div className="space-y-4">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="1.5 × 3 sheet, two-up" className="input !py-1.5 text-sm" />
        </label>

        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold text-content dark:text-mortar-200">Media loaded ({u})</div>
          <div className="inline-flex rounded-md border border-line dark:border-slate-700 p-0.5 text-xs">
            {(["in", "mm"] as Unit[]).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setUnit(opt)}
                className={`px-2.5 py-0.5 rounded transition ${unit === opt ? "bg-cobble-600 text-white" : "text-faint dark:text-slate-400 hover:text-accent"}`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 -mt-2">
          <NumField label="width" value={mediaW} onChange={setMediaW} step={mainStep} />
          <NumField label="height" value={mediaH} onChange={setMediaH} step={mainStep} />
        </div>

        <div>
          <div className="text-[11px] font-semibold text-content dark:text-mortar-200 mb-1.5">Each label ({u})</div>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="width" value={labelW} onChange={setLabelW} step={mainStep} />
            <NumField label="height" value={labelH} onChange={setLabelH} step={mainStep} />
          </div>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-faint dark:text-slate-400 text-xs">Margins &amp; gaps (optional)</summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <NumField label="margin left" value={marginL} onChange={setMarginL} step={fineStep} />
            <NumField label="margin top" value={marginT} onChange={setMarginT} step={fineStep} />
            <NumField label="gap across" value={colGap} onChange={setColGap} step={fineStep} />
            <NumField label="gap down" value={rowGap} onChange={setRowGap} step={fineStep} />
          </div>
        </details>

        {/* Live preview: the tile count + a sketch of the grid. */}
        <div className="rounded-lg border border-line dark:border-slate-700 p-3 bg-subtle/40 dark:bg-slate-800/40">
          {fits ? (
            <>
              <div className="text-sm font-semibold text-content dark:text-mortar-100">
                {perSheet} label{perSheet === 1 ? "" : "s"} per sheet
                <span className="text-faint dark:text-slate-400 font-normal"> · {grid.cols} across × {grid.rows} down</span>
              </div>
              <TileSketch cols={grid.cols} rows={grid.rows} mediaW={dims.media_w} mediaH={dims.media_h} />
            </>
          ) : (
            <div className="text-sm text-amber-700 dark:text-amber-400">
              A {num(labelW)}×{num(labelH)} {u === "mm" ? "mm" : "in"} label does not fit a {num(mediaW)}×{num(mediaH)} {u === "mm" ? "mm" : "in"} media with those margins.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm border border-line dark:border-slate-700 hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!fits || !name.trim() || create.isPending}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
          >
            {create.isPending ? "Saving…" : "Save size"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A small proportional sketch of the tile grid, so the layout is visible, not
 *  just a number. Capped so a 30-up sheet stays a thumbnail. */
function TileSketch({ cols, rows, mediaW, mediaH }: { cols: number; rows: number; mediaW: number; mediaH: number }) {
  if (cols < 1 || rows < 1 || mediaW <= 0 || mediaH <= 0) return null;
  const maxPx = 96;
  const scale = maxPx / Math.max(mediaW, mediaH);
  const w = mediaW * scale;
  const h = mediaH * scale;
  return (
    <div className="mt-2 inline-grid gap-[2px] border border-slate-400/60 bg-white dark:bg-slate-900 p-[2px]"
      style={{ width: w, height: h, gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
    >
      {Array.from({ length: Math.min(cols * rows, 120) }).map((_, i) => (
        <div key={i} className="bg-cobble-200/70 dark:bg-cobble-800/50 rounded-[1px]" />
      ))}
    </div>
  );
}
