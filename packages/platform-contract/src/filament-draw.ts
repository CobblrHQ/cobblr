// What a print uses and what it drew, on a digifab job (#4016).
//
// One definition for digifab (which writes them), Makes (which reads them for
// a print's history) and the slicer step (which writes the grams), so the
// three never disagree on the shape of the same column.

/** `digifab_jobs.material_grams_by_tool`: the slicer's grams per filament,
 *  tool 1 first (index 0 is filament 1, the spool in slot "1"). A filament a
 *  print does not use reads 0. Null when the file stated only a total. */
export type GramsByTool = number[];

/** One spool a completed print drew on. */
export interface FilamentDraw {
  /** The spool: an inventory record (kind `inventory:part`). */
  part_id: string;
  grams: number;
  /** The loaded printer slot ("1".."n"), or null for a spool selected directly. */
  slot: string | null;
}

/** `digifab_jobs.material_drawn`: exactly what a completed print took off
 *  each loaded spool; a print scrapped at the bed puts back exactly this.
 *  Null before completion; acknowledged draws during material accounting. */
export type FilamentDrawn = FilamentDraw[];

/** Read `material_drawn` as stored (jsonb), ignoring anything malformed. */
export function readFilamentDrawn(raw: unknown): FilamentDrawn {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d) => {
    const r = d as Partial<FilamentDraw> | null;
    return r && typeof r.part_id === "string" && (r.slot === null || typeof r.slot === "string") && Number(r.grams) > 0 ? [{ part_id: r.part_id, grams: Number(r.grams), slot: r.slot }] : [];
  });
}

/** Read `material_grams_by_tool` as stored (jsonb); null when absent or empty. */
export function readGramsByTool(raw: unknown): GramsByTool | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map((g) => (typeof g === "number" && Number.isFinite(g) && g > 0 ? g : 0));
  return out.some((g) => g > 0) ? out : null;
}
