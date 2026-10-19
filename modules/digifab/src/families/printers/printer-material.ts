// Whether a printer's loaded material can take a job: its material, colour,
// chosen spool and grams, slot by slot (the farm asks through core/printing.ts
// FamilyPrinting.materialRefusal before it gives a printer a job).
import type { LoadedSpool, PrinterMaterial } from "../../core/printing.js";
import { gramsByTool, planDraw } from "./loaded-spools.js";
import { sameColour } from "./pick-printer.js";

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
export function printerMaterialRefusal(job: PrinterMaterial, loaded: LoadedSpool[]): string | null {
 const tools = gramsByTool(job.material_grams_by_tool);
 const grams = Number(job.material_grams) > 0 ? Number(job.material_grams) : tools?.reduce((n, g) => n + g, 0) ?? 0;
 const material = job.material_type?.trim() || null;
 const hasTraits = material || job.material_part_id || job.material_by_tool?.some(Boolean) || job.color_by_tool?.some(Boolean);
 if (!hasTraits && !grams && !tools) return null;
 if (job.material_part_id && tools && tools.filter(g => g > 0).length > 1) return "Waiting for material: use the loaded spools for a plate with more than one filament.";
 const matches = (spool: LoadedSpool, tool: number, needed: number) => {
  const type = job.material_by_tool?.[tool] || material;
  const color = job.color_by_tool?.[tool];
  return (!type || norm(spool.material) === norm(type)) && (!color || sameColour(spool.color, color)) &&
   (!job.material_part_id || spool.spool.id === job.material_part_id) &&
   spool.grams_left !== null && (needed > 0 ? spool.grams_left >= needed : spool.grams_left > 0);
 };
 const color = job.color_by_tool?.find(Boolean);
 const need = `${color ? `${color} ` : ""}${material || "the chosen spool"}`;
 const refusal = `Waiting for material: load ${grams ? `at least ${grams} g of ` : ""}${need}.`;
 const slotRefusal = (slot: string, tool: number, needed: number) => {
  const type = job.material_by_tool?.[tool] || material || "the chosen spool";
  const color = job.color_by_tool?.[tool];
  return `Waiting for material: slot ${slot} needs at least ${needed} g of ${color ? `${color} ` : ""}${type}.`;
 };
 const slotted = loaded.filter(spool => spool.slot);
 if (job.material_part_id) return slotted.some(spool => matches(spool, tools?.findIndex(g => g > 0) ?? 0, grams)) ? null : refusal;
 if (!grams) return slotted.some(spool => matches(spool, 0, 0)) ? null : refusal;
 const draw = planDraw(slotted.map(spool => ({ slot: spool.slot!, partId: spool.spool.id })), tools, grams);
 const missing = draw.unfed[0];
 if (missing) return slotRefusal(missing.slot, Number(missing.slot) - 1, missing.grams);
 if (!draw.draws.length) return refusal;
 for (const d of draw.draws) {
  const spool = slotted.find(spool => spool.spool.id === d.part_id && spool.slot === d.slot);
  const tool = slotted.length === 1 && tools ? tools.findIndex(g => g > 0) : Number(d.slot) - 1;
  if (!spool || !matches(spool, Math.max(0, tool), d.grams)) return slotRefusal(d.slot, Math.max(0, tool), d.grams);
 }
 return null;
}
