// A 3D printer's Printing profile (Services §14.3): what a slicer needs to
// know about it. The printer model is a neutral id ("bambulab/a1") each slicer
// maps to its own presets, so one profile serves every slicer a workspace
// connects; the build volume is what "does it fit" is judged against when a
// printer is picked for a print; a preset per filament type keeps a tuned
// slicer preset when there is one.
//
// Only on 3D printers: a laser cutter or CNC machine has no slicer, and its
// page never says "print" (machine-words.ts).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { SlidersHorizontal } from "lucide-react";
import { api, ApiError, type PrintingProfile } from "../../lib/api";
import { machineWords } from "../../lib/machine-words";
import { onModelChosen, sliceChoices } from "./printingProfileChoices";
import type { EntityDetailPanelCtx } from "../../panels/types";

const field =
  "w-full rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-mortar-100 placeholder:text-faint";
const label = "block text-xs font-medium text-muted dark:text-slate-400 mb-1";

const toNum = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) && n > 0 ? n : null;
};

export function PrintingProfilePanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  if (machineWords(ctx.hints?.machine_kind).kind !== "3d-printer") return null;
  return <PrintingProfileForm slug={ctx.slug} machineId={ctx.entityId} />;
}

function PrintingProfileForm({ slug, machineId }: { slug: string; machineId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["printing-profile", slug, machineId], queryFn: () => api.getPrintingProfile(slug, machineId) });
  const [model, setModel] = useState("");
  const [nozzle, setNozzle] = useState("");
  const [vol, setVol] = useState<[string, string, string]>(["", "", ""]);
  const [quality, setQuality] = useState("");
  const [hints, setHints] = useState<Record<string, string>>({});
  // The connected slicer's choices, when one is connected: its models, and
  // for the chosen one its nozzles, qualities and presets. Without one, the
  // fields stay free text.
  const optionsQ = useQuery({
    queryKey: ["service-options", slug, "slice.model"],
    queryFn: () => api.getServiceCapabilityOptions(slug, "slice.model"),
    staleTime: 5 * 60_000,
  });
  const choices = sliceChoices(optionsQ.data, model);
  const [otherModel, setOtherModel] = useState(false);
  const modelListed = !!choices?.models.some((m) => m.id === model.trim());
  const chooseModel = (id: string) => {
    setModel(id);
    const next = onModelChosen(sliceChoices(optionsQ.data, id)?.model ?? null, { volume: vol, nozzle });
    setVol(next.volume);
    setNozzle(next.nozzle);
  };

  useEffect(() => {
    const p = q.data?.profile;
    if (!p) return;
    setModel(p.printer_model ?? "");
    setNozzle(p.nozzle_mm != null ? String(p.nozzle_mm) : "");
    setVol(p.build_volume_mm ? (p.build_volume_mm.map(String) as [string, string, string]) : ["", "", ""]);
    setQuality(p.default_quality ?? "");
    setHints(p.preset_hints ?? {});
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const v = vol.map(toNum);
      const body: Partial<PrintingProfile> = {
        printer_model: model.trim() || null,
        nozzle_mm: toNum(nozzle),
        build_volume_mm: v.every((x) => x !== null) ? (v as [number, number, number]) : null,
        default_quality: quality.trim() || null,
        preset_hints: Object.fromEntries(Object.entries(hints).filter(([, h]) => h.trim())),
      };
      return api.savePrintingProfile(slug, machineId, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["printing-profile", slug, machineId] });
      toast.success("Printing profile saved");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save the Printing profile."),
  });

  if (q.isLoading) return null;
  const types = q.data?.filament_types ?? [];
  const partialVolume = vol.some((x) => x.trim()) && !vol.every((x) => toNum(x) !== null);

  return (
    <section data-testid="printing-profile" className="space-y-3 rounded-lg border border-line dark:border-slate-700 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
        <SlidersHorizontal size={12} aria-hidden />
        Printing profile
      </div>
      <p className="text-xs text-muted dark:text-slate-400">
        What a slicer needs to know about this printer. A part is only sent here when it fits the build volume.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={label} htmlFor={`pp-model-${machineId}`}>
            Printer model
          </label>
          {choices && !otherModel && (modelListed || !model.trim()) ? (
            <select
              id={`pp-model-${machineId}`}
              value={model}
              onChange={(e) => (e.target.value === "__other" ? setOtherModel(true) : chooseModel(e.target.value))}
              className={field}
            >
              <option value="">Choose the printer model</option>
              {choices.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="__other">Another model…</option>
            </select>
          ) : (
            <input
              id={`pp-model-${machineId}`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. bambulab/a1"
              className={field}
            />
          )}
          {!choices && optionsQ.isFetched && (
            <p className="mt-1 text-xs text-faint">Connect a slicer to pick the model from its list.</p>
          )}
        </div>
        <div>
          <label className={label} htmlFor={`pp-nozzle-${machineId}`}>
            Nozzle (mm)
          </label>
          {choices?.nozzles.length ? (
            <select id={`pp-nozzle-${machineId}`} value={nozzle} onChange={(e) => setNozzle(e.target.value)} className={field}>
              {!choices.nozzles.includes(Number(nozzle)) && <option value={nozzle}>{nozzle || "Choose"}</option>}
              {choices.nozzles.map((n) => (
                <option key={n} value={String(n)}>
                  {n} mm
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`pp-nozzle-${machineId}`}
              inputMode="decimal"
              value={nozzle}
              onChange={(e) => setNozzle(e.target.value)}
              placeholder="0.4"
              className={field}
            />
          )}
        </div>
      </div>
      <div>
        <span className={label}>Build volume (mm)</span>
        <div className="grid grid-cols-3 gap-2">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <input
              key={axis}
              aria-label={`Build volume ${axis} (mm)`}
              inputMode="decimal"
              value={vol[i]}
              onChange={(e) => setVol((v) => v.map((x, j) => (j === i ? e.target.value : x)) as [string, string, string])}
              placeholder={axis}
              className={field}
            />
          ))}
        </div>
        {partialVolume && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">All three sizes are needed, or none.</p>}
      </div>
      <div>
        <label className={label} htmlFor={`pp-quality-${machineId}`}>
          Default quality
        </label>
        {choices?.qualities.length ? (
          <select id={`pp-quality-${machineId}`} value={quality} onChange={(e) => setQuality(e.target.value)} className={field}>
            <option value="">The slicer's default</option>
            {!choices.qualities.some((q) => q.id === quality) && quality && <option value={quality}>{quality}</option>}
            {choices.qualities.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`pp-quality-${machineId}`}
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
            placeholder="e.g. 0.20mm standard"
            className={field}
          />
        )}
      </div>
      {types.length > 0 && (
        <div>
          <span className={label}>Slicer preset per filament (optional)</span>
          <div className="space-y-2">
            {types.map((t) => (
              <div key={t.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,12rem)_1fr] items-center gap-1 sm:gap-2">
                <span className="truncate text-sm text-content dark:text-mortar-100" title={t.name ?? t.id}>
                  {t.name ?? "A filament type"}
                </span>
                <input
                  aria-label={`Slicer preset for ${t.name ?? "this filament"}`}
                  value={hints[t.id] ?? ""}
                  onChange={(e) => setHints((h) => ({ ...h, [t.id]: e.target.value }))}
                  placeholder="e.g. Generic PETG"
                  list={choices?.presets.length ? `pp-presets-${machineId}` : undefined}
                  className={field}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {choices?.presets.length ? (
        <datalist id={`pp-presets-${machineId}`}>
          {choices.presets.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          disabled={save.isPending || partialVolume}
          onClick={() => save.mutate()}
          className="min-h-9 rounded-md bg-cobble-600 px-3 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
