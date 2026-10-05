import { useId, useState } from "react";
import type { LaserMaterialTag } from "../../lib/api";

export function LaserMaterialForm({ initial, onSave, busy = false }: { initial?: Partial<LaserMaterialTag>; onSave: (tag: LaserMaterialTag) => Promise<void>; busy?: boolean }) {
  const id = useId();
  const [material, setMaterial] = useState(initial?.material ?? "");
  const [thickness, setThickness] = useState<number | "">(initial?.thickness_mm ?? "");
  const [width, setWidth] = useState<number | "">(initial?.width_mm ?? "");
  const [height, setHeight] = useState<number | "">(initial?.height_mm ?? "");
  const input = "min-h-11 w-full rounded border border-line bg-surface px-3 py-2";
  return <form onSubmit={e => { e.preventDefault(); void onSave({ material: material.trim(), thickness_mm: Number(thickness), width_mm: Number(width), height_mm: Number(height) }); }} className="space-y-3">
    <label htmlFor={`${id}-material`} className="block">Material<input id={`${id}-material`} required maxLength={120} value={material} onChange={e => setMaterial(e.target.value)} className={input} /></label>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {[{ name: "Thickness (mm)", value: thickness, set: setThickness }, { name: "Width (mm)", value: width, set: setWidth }, { name: "Height (mm)", value: height, set: setHeight }].map((f, i) => <label key={f.name} htmlFor={`${id}-${i}`} className="block">{f.name}<input id={`${id}-${i}`} type="number" inputMode="decimal" required min="0.01" step="any" max={i === 0 ? 1000 : 100000} value={f.value} onChange={e => f.set(e.target.value === "" ? "" : Number(e.target.value))} className={input} /></label>)}
    </div>
    <button type="submit" disabled={busy} className="min-h-11 rounded bg-ember-600 px-4 py-2 text-white disabled:opacity-50">{busy ? "Saving…" : "Save material"}</button>
  </form>;
}
