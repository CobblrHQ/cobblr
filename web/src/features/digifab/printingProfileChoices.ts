// What a connected slicer offers for a Printing profile (Services §3, the
// slice.* options answer): its printer models, and for the chosen one its
// nozzles, qualities and filament presets. Pure, so the form's pickers can be
// held to it without a slicer.
import type { SliceOptions } from "@cobblr/platform-contract/services";

type Model = SliceOptions["printer_models"][number];

export interface SliceChoices {
  models: Array<{ id: string; label: string }>;
  /** The chosen model's entry, when the slicer knows it. */
  model: Model | null;
  nozzles: number[];
  qualities: Array<{ id: string; label: string }>;
  presets: string[];
}

/** Null when there is no usable answer (no slicer, or one that answered
 *  another shape): the form keeps its free-text fields. */
export function sliceChoices(options: unknown, modelId: string): SliceChoices | null {
  const o = options as Partial<SliceOptions> | null | undefined;
  const list = Array.isArray(o?.printer_models) ? o!.printer_models.filter((m) => m && typeof m.id === "string" && m.id) : [];
  if (!list.length) return null;
  const model = list.find((m) => m.id === modelId.trim()) ?? null;
  return {
    models: list.map((m) => ({ id: m.id, label: m.display_name || m.id })).sort((a, b) => a.label.localeCompare(b.label)),
    model,
    nozzles: model?.nozzles?.filter((n) => typeof n === "number" && n > 0) ?? [],
    qualities: (model?.qualities ?? []).map((q) => ({ id: q.id, label: q.label || q.id })),
    presets: [...new Set((model?.filament_presets ?? []).map((p) => p.name).filter(Boolean))],
  };
}

/** What choosing a model fills in: its build volume when none was typed, and
 *  a nozzle it takes (0.4 mm when it has one) when the one set is not. */
export function onModelChosen(
  model: Model | null,
  current: { volume: [string, string, string]; nozzle: string },
): { volume: [string, string, string]; nozzle: string } {
  if (!model) return current;
  const volume = current.volume.every((v) => !v.trim()) && model.build_volume_mm?.length === 3
    ? (model.build_volume_mm.map(String) as [string, string, string])
    : current.volume;
  const n = Number(current.nozzle);
  // The usual 0.4 mm when the model takes it, else its first.
  const fallback = model.nozzles?.includes(0.4) ? 0.4 : model.nozzles?.[0];
  const nozzle = model.nozzles?.length && !model.nozzles.includes(n) ? String(fallback) : current.nozzle;
  return { volume, nozzle };
}
