import { poolGroupCondition } from "./pool-groups.js";
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform, SYSTEM_VIEWER, type EntityViewer } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { materialFromFields } from "./laser-material.js";
import { familyMaterialRefusal, familyPrinting } from "./core/families.js";
import { materialShortages, type FloorSheet } from "./material-dispatch.js";
export const Dispatch = z.object({ library_id: z.string().uuid(), quantity: z.number().int().min(1).max(10000), material: z.string().trim().min(1).max(120), thickness_mm: z.number().positive().max(1000), operations: z.record(z.enum(["cut", "score", "engrave"])), spacing_mm: z.number().min(0).max(100).default(1), kerf_mm: z.number().min(0).max(100).default(0), rotate: z.boolean().default(true), dxf_units: z.enum(["mm", "in"]).default("mm") });
export type DispatchRequest = z.infer<typeof Dispatch>;
// SYSTEM-READ: Internal dispatch and digest checks need the actual stock; screen reads pass their viewer.
export async function floorStock(orgId: string, viewer: EntityViewer = SYSTEM_VIEWER) {
 const kinds = (await platform().entities.listKindsForOrg(orgId)).filter(k => k.fields.some(f => f.name === "sheet_geometry") && k.fields.some(f => f.role === "quantity"));
 const spools: { id: string; material: string; grams: number }[] = [];
 const sheets: FloorSheet[] = [], materials = new Map<string, { material: string; thickness_mm: number | null; sheets: number; offcuts: number; free_mm2: number; spools: number; grams: number }>();
 const seen = new Set<string>();
 let complete = kinds.length > 0;
 for (const record of kinds) {
  const kind = record.id;
  const baseKind = record.instance_name ? await platform().entities.baseKindOf(orgId, kind) : kind;
  if (!viewer.system) { const hidden = await platform().entities.hiddenFields(orgId, kind, viewer); complete &&= !["qty", "metadata", "sheet_geometry"].some(f => hidden.has(f)); }
  const page = await platform().entities.listAll(orgId, kind, {}, viewer);
  complete &&= page.complete && page.items.every(p => p.fields.qty !== undefined && p.fields.metadata !== undefined);
  const physical = page.items.filter(p => {
   if (p.retired || !(Number(p.fields.qty) > 0)) return false;
   const key = `${baseKind}:${p.id}`;
   if (seen.has(key)) return false;
   seen.add(key);
   return true;
  });
  const types = await platform().pairings.findBySources({ orgId, sourceKind: baseKind, sourceIds: physical.map(p => p.id), targetKind: baseKind, relationshipKind: "instance-of" });
  const typeIds = [...new Set(types.map(t => t.targetId))];
  const typeRows = typeIds.length ? await platform().entities.lookupMany(orgId, typeIds.map(id => ({ kind: baseKind, id })), viewer) : [];
  for (const item of physical) {
   const spec = materialFromFields(item.fields);
   const geometry = item.fields.sheet_geometry as { revision: number; free_rectangles: FloorSheet["free_rectangles"]; percent_left: number; offcut: boolean; used_outlines?: FloorSheet["used_outlines"]; cut_capacity?: FloorSheet["cut_capacity"] } | undefined;
   const type = typeRows.find(t => t.id === types.find(t => t.sourceId === item.id)?.targetId);
   const metadata = { ...(type?.fields.metadata as Record<string, unknown> ?? {}), ...(item.fields.metadata as Record<string, unknown> ?? {}) };
   const material = spec?.material ?? (typeof metadata.material === "string" ? metadata.material : null);
   if (!material) continue;
   const unit = String(item.fields.unit ?? "").toLowerCase();
   const grams = ["g", "gram", "grams"].includes(unit) ? Number(item.fields.qty) : unit === "kg" ? Number(item.fields.qty) * 1000 : 0;
   if (!spec && !grams) continue;
   const key = `${material.toLowerCase()}:${spec?.thickness_mm ?? "filament"}`;
   const entry = materials.get(key) ?? { material, thickness_mm: spec?.thickness_mm ?? null, sheets: 0, offcuts: 0, free_mm2: 0, spools: 0, grams: 0 };
   if (spec && geometry?.free_rectangles) {
    const free = Number.isFinite(geometry.percent_left) ? spec.width_mm * spec.height_mm * geometry.percent_left / 100 : 0;
    entry.sheets++; entry.offcuts += geometry.offcut ? 1 : 0; entry.free_mm2 += free;
    sheets.push({ id: item.id, name: item.title, material, thickness_mm: spec.thickness_mm, width: spec.width_mm, height: spec.height_mm, revision: geometry.revision, free_rectangles: geometry.free_rectangles, used_outlines: geometry.used_outlines, cut_capacity: geometry.cut_capacity });
   } else { entry.spools++; entry.grams += grams; spools.push({ id: item.id, material, grams }); }
   materials.set(key, entry);
  }
 }
 return { sheets, spools, materials: [...materials.values()], complete };
}
export async function floorSnapshot(db: Kysely<DigifabDB>, orgId: string, viewer: EntityViewer) {
 const [stock, candidates, jobs, batches, profiles, drawings, pools, members] = await Promise.all([
  floorStock(orgId, viewer), familyPrinting()?.candidates(orgId, db) ?? Promise.resolve([]),
  db.selectFrom("digifab_jobs").select(["id", "connection_id", "target_device", "target_pool", "file_ref", "metadata", "status", "progress", "eta_sec", "material_type", "material_part_id", "material_grams", "material_grams_by_tool", "priority", "error", "run_id", "created_at"]).where("status", "not in", ["completed", "cancelled", "failed"]).orderBy("priority", "desc").orderBy("created_at", "asc").execute(),
  db.selectFrom("digifab_material_dispatches").selectAll().where("status", "not in", ["dispatched", "cancelled"]).orderBy("created_at", "asc").execute(),
  db.selectFrom("digifab_laser_profiles").select(["profile", "connection_id", "remote_device_id"]).execute(),
  db.selectFrom("digifab_library").select(["id", "name", "kind"]).where("kind", "in", ["svg", "dxf"]).orderBy("name", "asc").execute(),
  db.selectFrom("digifab_pools").where(poolGroupCondition()).select(["id", "name"]).execute(), db.selectFrom("digifab_pool_members").select(["pool_id", "connection_id", "remote_device_id"]).execute(),
 ]);
 const planIds = batches.flatMap(b => b.plan_ids);
 return {
  jobs: jobs.map(job => {
   const eligible = candidates.filter(c => job.target_pool ? members.some(m => m.pool_id === job.target_pool && m.connection_id === c.device.connection_id && m.remote_device_id === c.device.remote_device_id) : c.device.connection_id === job.connection_id && c.device.remote_device_id === job.target_device);
   const needsMaterial = job.status === "queued" && !!job.target_pool && (familyMaterialRefusal(job, []) !== null);
   return { ...job, blocked: needsMaterial ? eligible.some(c => !familyMaterialRefusal(job, c.loaded)) ? null : familyMaterialRefusal(job, []) : null };
  }), batches, layouts: planIds.length ? await db.selectFrom("digifab_laser_plans").selectAll().where("id", "in", planIds).execute() : [], reorders: materialShortages(jobs, batches, stock), laser_devices: profiles.map(p => ({ connection_id: p.connection_id, device_id: p.remote_device_id })), stock: stock.materials, stock_complete: stock.complete, drawings, pools, members,
  laser_materials: [...new Map(profiles.map(p => [`${p.profile.material.toLowerCase()}:${p.profile.thickness_mm}`, { material: p.profile.material, thickness_mm: p.profile.thickness_mm }])).values()],
 };
}
let registered = false;
export function registerFloorManager(): void {
 if (registered) return; registered = true;
 platform().notifications.registerDigestContributor("inventory.low-stock", "digifab", async (orgId, raw) => {
  const db = raw as Kysely<DigifabDB>;
  const [jobs, batches, stock] = await Promise.all([db.selectFrom("digifab_jobs").select(["id", "file_ref", "status", "material_type", "material_part_id", "material_grams"]).where("status", "=", "queued").where("target_pool", "is not", null).execute(), db.selectFrom("digifab_material_dispatches").select(["id", "error", "shortage"]).where("status", "=", "blocked").where("shortage", "=", true).execute(), floorStock(orgId)]);
  return materialShortages(jobs, batches, stock);
 });
}
