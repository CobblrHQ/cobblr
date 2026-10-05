import { z } from "zod";

export const LaserMaterialSchema = z.object({
  material: z.string().trim().min(1).max(120),
  thickness_mm: z.number().positive().max(1000),
  width_mm: z.number().positive().max(100000),
  height_mm: z.number().positive().max(100000),
});
export type LaserMaterial = z.infer<typeof LaserMaterialSchema>;

export function materialMismatch(required: LaserMaterial, sheet: LaserMaterial): string | null {
  if (required.material.toLowerCase() !== sheet.material.toLowerCase()) return `This job needs ${required.material}, but this sheet is ${sheet.material}.`;
  if (Math.abs(required.thickness_mm - sheet.thickness_mm) > 0.01) return `This job needs ${required.thickness_mm} mm ${required.material}, but this sheet is ${sheet.thickness_mm} mm.`;
  if (sheet.width_mm < required.width_mm || sheet.height_mm < required.height_mm) return `This job needs at least ${required.width_mm} × ${required.height_mm} mm, but this sheet is ${sheet.width_mm} × ${sheet.height_mm} mm.`;
  return null;
}

export function materialFromFields(fields: Record<string, unknown>): LaserMaterial | null {
  const metadata = fields.metadata as Record<string, unknown> | null;
  const geometry = fields.sheet_geometry as { spec?: unknown } | undefined;
  const native = LaserMaterialSchema.safeParse(geometry?.spec ?? metadata);
  const parsed = native.success ? native : LaserMaterialSchema.safeParse(metadata?.laser_sheet);
  return parsed.success ? parsed.data : null;
}

export function matchingLibraryMaterial(cuts: Record<string, unknown>[], library: Record<string, unknown>): { material: string; thickness_mm: number } | null {
  const enabled = cuts.filter(c => c.enabled !== false);
  const entries = Array.isArray(library.entries) ? library.entries : [];
  const matches = entries.filter((raw): raw is Record<string, unknown> => {
    if (!raw || typeof raw !== "object") return false;
    const e = raw as Record<string, unknown>;
    const cut = e.cut as Record<string, unknown> | undefined;
    if (!cut || typeof e.material !== "string" || typeof e.thickness !== "number" || e.thickness <= 0 || !enabled.length) return false;
    const settings = cut.params as Record<string, unknown> | undefined;
    return enabled.every(c => {
      const p = c.params as Record<string, unknown> | undefined;
      return p && settings && ["speed", "min_power", "max_power", "num_passes"].every(k => p[k] != null && p[k] === settings[k]) && c.mode === cut.mode;
    });
  });
  const distinct = new Map(matches.map(e => [`${e.material}:${e.thickness}`, e]));
  if (distinct.size !== 1) return null;
  const e = [...distinct.values()][0]!;
  return { material: String(e.material), thickness_mm: Number(e.thickness) };
}

export function preparedSheetAreaMismatch(required: LaserMaterial, fields: Record<string, unknown>): string | null {
  const geometry = fields.sheet_geometry as { free_rectangles?: Array<{ x: number; y: number; width: number; height: number }> } | undefined;
  if (!geometry) return null;
  return geometry.free_rectangles?.some(r => r.x === 0 && r.y === 0 && r.width >= required.width_mm && r.height >= required.height_mm) ? null : "This prepared job reaches a used area. Choose a sheet with free space at its saved origin.";
}
