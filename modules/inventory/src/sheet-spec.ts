// A sheet's dimensions and rules, read from its record. Kept apart from the
// geometry (sheet-area.ts, sheet-geometry.ts) so a screen can read a sheet's
// spec without loading the polygon engine.
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface SheetSpec { material: string; thickness_mm: number; width_mm: number; height_mm: number; minimum_usable_mm: number; offcut_percent: number }

export function sheetSpec(metadata: Record<string, unknown>): SheetSpec | null {
  const legacy = metadata.laser_sheet as Record<string, unknown> | undefined;
  const native = metadata.material != null && metadata.width_mm != null ? metadata : legacy;
  if (!native || typeof native.material !== "string" || !native.material.trim()) return null;
  const n = (key: string, fallback?: number) => native[key] == null || native[key] === "" ? fallback! : Number(native[key]);
  const s = { material: native.material.trim(), thickness_mm: n("thickness_mm"), width_mm: n("width_mm"), height_mm: n("height_mm"), minimum_usable_mm: Number(metadata.minimum_usable_mm ?? 20), offcut_percent: Number(metadata.offcut_percent ?? 25) };
  return [s.thickness_mm, s.width_mm, s.height_mm, s.minimum_usable_mm].every(v => Number.isFinite(v) && v > 0 && v <= 100000) && Number.isFinite(s.offcut_percent) && s.offcut_percent >= 0 && s.offcut_percent <= 100 ? s : null;
}
