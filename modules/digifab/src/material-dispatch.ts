import { gramsByTool, planDraw } from "./loaded-spools.js";
import type { LoadedSpool } from "./pick-printer.js";
import { nestParts, type Design, type Sheet, type Profile } from "./laser-layout.js";
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
export function printerMaterialRefusal(job: { material_type?: string | null; material_part_id?: string | null; material_grams?: unknown; material_grams_by_tool?: unknown }, loaded: LoadedSpool[]): string | null {
 const tools = gramsByTool(job.material_grams_by_tool);
 if (!job.material_type && !job.material_part_id && !(Number(job.material_grams) > 0) && !tools) return null;
 const grams = Number(job.material_grams) > 0 ? Number(job.material_grams) : tools?.reduce((n, g) => n + g, 0) ?? 0;
 const matches = loaded.filter(s => (!job.material_type || norm(s.material) === norm(job.material_type)) && (!job.material_part_id || s.spool.id === job.material_part_id));
 if (tools && !job.material_part_id) {
  const draw = planDraw(loaded.filter(s => s.slot).map(s => ({ slot: s.slot!, partId: s.spool.id })), tools, grams);
  if (!draw.unfed.length && draw.draws.length && draw.draws.every(d => matches.some(s => s.spool.id === d.part_id && s.grams_left !== null && s.grams_left >= d.grams))) return null;
 } else if (matches.some(s => grams ? s.grams_left !== null && s.grams_left >= grams : s.grams_left !== null && s.grams_left > 0)) return null;
 return `Waiting for material: load ${grams ? `at least ${grams} g of ` : ""}${job.material_type || "the chosen spool"}.`;
}
export type FloorSheet = Sheet & { name: string; material: string; thickness_mm: number };
export type LaserCandidate = { connection_id: string; device_id: string; name: string; bed: { width: number; height: number }; profiles: Record<string, { id: string; profile: Profile }> };
export type BatchAsk = { material: string; thickness_mm: number; quantity: number; spacing_mm: number; kerf_mm: number; rotate: boolean };
export type LaserAllocation = { machine: LaserCandidate; quantity: number; sheet_ids: string[] };
export function allocateLaserBatch(design: Design, ask: BatchAsk, candidates: LaserCandidate[], stock: FloorSheet[]): LaserAllocation[] {
 const machines = candidates.filter(c => Object.values(c.profiles).length && Object.values(c.profiles).every(p => norm(p.profile.material) === norm(ask.material) && Math.abs(p.profile.thickness_mm - ask.thickness_mm) < 0.01));
 if (!machines.length) throw new Error("No available laser has all the required material profiles.");
 const sheets = stock.filter(s => norm(s.material) === norm(ask.material) && Math.abs(s.thickness_mm - ask.thickness_mm) < 0.01 && s.free_rectangles.length);
 const used = new Set<string>(), groups = new Map<string, LaserAllocation>();
 let left = ask.quantity;
 while (left > 0) {
  let moved = false;
  for (let i = 0; i < machines.length && left; i++) {
   const machine = machines[i]!;
   for (const sheet of sheets) {
    if (used.has(sheet.id) || sheet.width > machine.bed.width || sheet.height > machine.bed.height) continue;
    const remainingSheets = sheets.filter(s => !used.has(s.id)).length;
    let lo = 0, hi = Math.min(left, Math.ceil(left / Math.min(machines.length - i, remainingSheets)));
    while (lo < hi) {
     const mid = Math.ceil((lo + hi) / 2);
     try { nestParts(design, mid, [sheet], ask.spacing_mm, ask.kerf_mm, ask.rotate); lo = mid; } catch { hi = mid - 1; }
    }
    if (!lo) continue;
    const key = `${machine.connection_id}:${machine.device_id}`;
    const group = groups.get(key) ?? { machine, quantity: 0, sheet_ids: [] };
    group.quantity += lo; group.sheet_ids.push(sheet.id); groups.set(key, group);
    used.add(sheet.id); left -= lo; moved = true; break;
   }
  }
  if (!moved) throw new Error(`Restock ${ask.thickness_mm} mm ${ask.material}: room for ${ask.quantity - left} of ${ask.quantity} parts on the available sheets.`);
 }
 if (used.size > 50) throw new Error("Split this batch into at most 50 physical sheets at a time.");
 return [...groups.values()];
}

export function materialShortages(jobs: { id: string; file_ref: string; status: string; material_type: string | null; material_part_id: string | null; material_grams: unknown }[], batches: { id: string; error: string | null; shortage: boolean }[], stock: { complete: boolean; spools: { id: string; material: string; grams: number }[] }) {
 if (!stock.complete) return [];
 const missing = jobs.filter(j => j.status === "queued" && (j.material_type || j.material_part_id || Number(j.material_grams) > 0) && !stock.spools.some(s => (!j.material_type || s.material.toLowerCase() === j.material_type.toLowerCase()) && (!j.material_part_id || s.id === j.material_part_id) && s.grams >= (Number(j.material_grams) || 1)));
 return [...missing.map(j => ({ key: j.id, text: `${j.file_ref}: Restock ${j.material_type || "the chosen spool"}${Number(j.material_grams) > 0 ? `, at least ${j.material_grams} g` : ""}.`, link: "/digifab/manager" })), ...batches.filter(b => b.shortage && b.error).map(b => ({ key: b.id, text: b.error!, link: "/digifab/manager" }))];
}

export async function allocateOutlineLaserBatch(design: Design, ask: BatchAsk, candidates: LaserCandidate[], stock: FloorSheet[]): Promise<LaserAllocation[]> {
 const { nestOutlines } = await import("./outline-nesting.js");
 const machines=candidates.filter(c=>Object.values(c.profiles).length&&Object.values(c.profiles).every(p=>norm(p.profile.material)===norm(ask.material)&&Math.abs(p.profile.thickness_mm-ask.thickness_mm)<0.01));
 if(!machines.length)throw new Error("No available laser has all the required material profiles.");
 const available=stock.filter(s=>norm(s.material)===norm(ask.material)&&Math.abs(s.thickness_mm-ask.thickness_mm)<0.01);
 const used=new Set<string>(), groups:LaserAllocation[]=[];
 let left=ask.quantity;
 const started=performance.now();
 for(const machine of machines) {
  const sheets=available.filter(s=>!used.has(s.id)&&s.width<=machine.bed.width&&s.height<=machine.bed.height);
  if(!sheets.length)continue;
  const budget=Math.max(100,3000-Math.ceil(performance.now()-started));
  const plan=await nestOutlines(design,left,sheets,ask.spacing_mm,ask.kerf_mm,ask.rotate,{partial:true,budget_ms:budget});
  const quantity=plan.reduce((n,s)=>n+s.parts.length,0);
  if(quantity) {groups.push({machine,quantity,sheet_ids:plan.map(s=>s.id)});for(const s of plan)used.add(s.id);left-=quantity;}
  if(!left)return groups;
  if(performance.now()-started>=3000)break;
 }
 throw new Error(`Restock ${ask.thickness_mm} mm ${ask.material}: room for ${ask.quantity-left} of ${ask.quantity} parts on the available sheets.`);
}
