import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform, SYSTEM_VIEWER, readJsonArg, type EntityViewer } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { parseDesign } from "./laser-design.js";
import { materialFromFields } from "./laser-material.js";
import { acceptLaserPlan, laserBed, LaserPlanRefusal } from "./laser-plans.js";
import { createLaserPlan } from "./api/laser-writes.js";
import { buildDriverById, NOT_OCCUPYING_STATUSES } from "./jobs-core.js";
import { ownedDeviceRefs } from "./detectors/owned.js";
import { gatherCandidates } from "./api/printing-profiles.js";
import { allocateLaserBatch, materialShortages, printerMaterialRefusal, type FloorSheet, type LaserCandidate } from "./material-dispatch.js";
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
   const geometry = item.fields.sheet_geometry as { revision: number; free_rectangles: FloorSheet["free_rectangles"]; percent_left: number; offcut: boolean } | undefined;
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
    sheets.push({ id: item.id, name: item.title, material, thickness_mm: spec.thickness_mm, width: spec.width_mm, height: spec.height_mm, revision: geometry.revision, free_rectangles: geometry.free_rectangles });
   } else { entry.spools++; entry.grams += grams; spools.push({ id: item.id, material, grams }); }
   materials.set(key, entry);
  }
 }
 return { sheets, spools, materials: [...materials.values()], complete };
}
export async function floorSnapshot(db: Kysely<DigifabDB>, orgId: string, viewer: EntityViewer) {
 const [stock, candidates, jobs, batches, profiles, drawings, pools, members] = await Promise.all([
  floorStock(orgId, viewer), gatherCandidates(orgId, db),
  db.selectFrom("digifab_jobs").select(["id", "connection_id", "target_device", "target_pool", "file_ref", "status", "progress", "eta_sec", "material_type", "material_part_id", "material_grams", "material_grams_by_tool", "priority", "error", "run_id", "created_at"]).where("status", "not in", ["completed", "cancelled", "failed"]).orderBy("priority", "desc").orderBy("created_at", "asc").execute(),
  db.selectFrom("digifab_material_dispatches").selectAll().where("status", "not in", ["dispatched", "cancelled"]).orderBy("created_at", "asc").execute(),
  db.selectFrom("digifab_laser_profiles").select(["profile", "connection_id", "remote_device_id"]).execute(),
  db.selectFrom("digifab_library").select(["id", "name", "kind"]).where("kind", "in", ["svg", "dxf"]).orderBy("name", "asc").execute(),
  db.selectFrom("digifab_pools").select(["id", "name"]).execute(), db.selectFrom("digifab_pool_members").select(["pool_id", "connection_id", "remote_device_id"]).execute(),
 ]);
 const planIds = batches.flatMap(b => b.plan_ids);
 return {
  jobs: jobs.map(job => {
   const eligible = candidates.filter(c => job.target_pool ? members.some(m => m.pool_id === job.target_pool && m.connection_id === c.device.connection_id && m.remote_device_id === c.device.remote_device_id) : c.device.connection_id === job.connection_id && c.device.remote_device_id === job.target_device);
   const needsMaterial = job.status === "queued" && !!job.target_pool && (printerMaterialRefusal(job, []) !== null);
   return { ...job, blocked: needsMaterial ? eligible.some(c => !printerMaterialRefusal(job, c.loaded)) ? null : printerMaterialRefusal(job, []) : null };
  }), batches, layouts: planIds.length ? await db.selectFrom("digifab_laser_plans").selectAll().where("id", "in", planIds).execute() : [], reorders: materialShortages(jobs, batches, stock), laser_devices: profiles.map(p => ({ connection_id: p.connection_id, device_id: p.remote_device_id })), stock: stock.materials, stock_complete: stock.complete, drawings, pools, members,
  laser_materials: [...new Map(profiles.map(p => [`${p.profile.material.toLowerCase()}:${p.profile.thickness_mm}`, { material: p.profile.material, thickness_mm: p.profile.thickness_mm }])).values()],
 };
}
async function laserCandidates(db: Kysely<DigifabDB>, orgId: string, request: DispatchRequest): Promise<LaserCandidate[]> {
 const profiles = await db.selectFrom("digifab_laser_profiles").select(["id", "profile", "connection_id", "remote_device_id"]).execute();
 const matching = profiles.filter(p => p.profile.material.toLowerCase() === request.material.toLowerCase() && Math.abs(p.profile.thickness_mm - request.thickness_mm) < 0.01);
 const devices = [...new Map(matching.map(p => [`${p.connection_id}:${p.remote_device_id}`, p])).values()];
 const result: LaserCandidate[] = [];
 const active = await db.selectFrom("digifab_jobs").select(["connection_id", "target_device"]).where("status", "not in", [...NOT_OCCUPYING_STATUSES]).execute();
 const owned = await ownedDeviceRefs(db);
 const attention = await db.selectFrom("digifab_device_attention").select(["connection_id", "remote_device_id"]).execute();
 for (const device of devices) {
  const mapped = Object.fromEntries(Object.entries(request.operations).map(([layer, operation]) => [layer, matching.find(p => p.connection_id === device.connection_id && p.remote_device_id === device.remote_device_id && p.profile.operation === operation)]));
  if (!Object.keys(mapped).length || Object.values(mapped).some(p => !p)) continue;
  if (owned.has(`${device.connection_id}:${device.remote_device_id}`) || active.some(a => a.connection_id === device.connection_id && a.target_device === device.remote_device_id) || attention.some(a => a.connection_id === device.connection_id && a.remote_device_id === device.remote_device_id)) continue;
  const driver = await buildDriverById(db, orgId, device.connection_id);
  if (!driver?.prepareJob || !await driver.jobReviewRequired?.()) continue;
  const live = (await driver.listDevices()).find(d => d.id === device.remote_device_id && d.enabled && ["idle", "ready", "operational"].includes((d.state ?? "").toLowerCase()));
  if (!live) continue;
  try { result.push({ connection_id: device.connection_id, device_id: device.remote_device_id, name: live.name, bed: await laserBed(db, orgId, device.connection_id, device.remote_device_id), profiles: Object.fromEntries(Object.entries(mapped).map(([layer, p]) => [layer, { id: p!.id, profile: p!.profile }])) }); }
  catch (e) { if (!(e instanceof LaserPlanRefusal)) throw e; }
 }
 return result;
}
export async function dispatchLaserBatch(db: Kysely<DigifabDB>, orgId: string, id: string, operation: "plan" | "queue" | "cancel" = "plan") {
 let answer: Record<string, unknown> = {};
 const lock = await platform().exclusive.run(`material-dispatch:${orgId}:${id}`, async () => {
  let batch = await db.selectFrom("digifab_material_dispatches").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  if (["dispatched", "cancelled"].includes(batch.status)) { answer = { batch }; return; }
  if (operation === "cancel") {
   await db.transaction().execute(async trx => {
    if (batch.plan_ids.length) await trx.selectFrom("digifab_laser_plans").select("id").where("id", "in", batch.plan_ids).forUpdate().execute();
    if (batch.plan_ids.length && await trx.selectFrom("digifab_laser_plans as p").innerJoin("digifab_production_runs as r", "r.id", "p.run_id").select("p.id").where("p.id", "in", batch.plan_ids).where("r.status", "not in", ["cancelled", "completed"]).executeTakeFirst()) throw new LaserPlanRefusal("Cancel the queued Production runs before withdrawing this batch.");
    if (batch.plan_ids.length) await trx.deleteFrom("digifab_laser_plans").where("id", "in", batch.plan_ids).where("run_id", "is", null).execute();
    batch = await trx.updateTable("digifab_material_dispatches").set({ status: "cancelled", error: null, shortage: false, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
   });
   answer = { batch }; return;
  }
  if (operation === "queue" && !batch.plan_ids.length) throw new LaserPlanRefusal("Preview the batch layouts before queueing it.");
  try {
   if (!batch.plan_ids.length) {
    const item = await db.selectFrom("digifab_library").select(["file_id"]).where("id", "=", batch.library_id).executeTakeFirstOrThrow();
    const file = await platform().files.read(orgId, item.file_id); if (!file) throw new LaserPlanRefusal("This drawing no longer exists.");
    const design = parseDesign(file.filename, file.bytes, batch.request.dxf_units);
    if ([...new Set(design.paths.map(p => p.layer))].some(layer => !batch.request.operations[layer])) throw new LaserPlanRefusal("Map every drawing layer to an operation.");
    const stock = await floorStock(orgId); if (!stock.complete) throw new LaserPlanRefusal("The stock list is incomplete. Use Prepare laser batch to choose sheets explicitly.");
    const claims = new Set((await db.selectFrom("digifab_laser_sheet_claims").select("part_id").execute()).map(c => c.part_id));
    let allocation;
    try { allocation = allocateLaserBatch(design, batch.request, await laserCandidates(db, orgId, batch.request), stock.sheets.filter(s => !claims.has(s.id))); } catch (e) { if (e instanceof Error) throw new LaserPlanRefusal(e.message); throw e; }
    batch = await db.transaction().execute(async trx => {
     const plans = [];
     for (const group of allocation) {
      const plan = await createLaserPlan(trx, orgId, { ...batch.request, connection_id: group.machine.connection_id, device_id: group.machine.device_id, quantity: group.quantity, sheet_ids: group.sheet_ids, mapping: Object.fromEntries(Object.entries(group.machine.profiles).map(([layer, profile]) => [layer, profile.id])) }); plans.push(plan.id);
     }
     return await trx.updateTable("digifab_material_dispatches").set({ plan_ids: sql<string[]>`${JSON.stringify(plans)}::jsonb`, status: "planned", error: null, shortage: false, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
    });
   }
   if (operation === "plan") { answer = { batch, layouts: await db.selectFrom("digifab_laser_plans").selectAll().where("id", "in", batch.plan_ids).execute() }; return; }
   const runs = [];
   for (const planId of batch.plan_ids) runs.push(await acceptLaserPlan(db, orgId, planId));
   batch = await db.updateTable("digifab_material_dispatches").set({ status: "dispatched", error: null, shortage: false, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
   answer = { batch, runs };
  } catch (e) {
   if (!(e instanceof LaserPlanRefusal)) throw e;
   const error = (e as Error).message;
   batch = await db.updateTable("digifab_material_dispatches").set({ status: "blocked", error, shortage: error.startsWith("Restock "), updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
   answer = { batch, blocked: error };
  }
 });
 if (!lock.ran) throw new LaserPlanRefusal("This batch is already being dispatched.");
 return answer;
}
let registered = false;
export function registerFloorManager(): void {
 if (registered) return; registered = true;
 platform().actions.registerHandler("digifab.dispatch-material", async ctx => {
  if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Dispatching a batch requires an admin." };
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
  const args = ctx.args ?? {};
  try {
   const operation = z.enum(["plan", "queue", "cancel"]).parse(args.operation);
   if (args.id) return { ok: true, ...await dispatchLaserBatch(db, ctx.orgId, z.string().uuid().parse(args.id), operation) };
   if (operation !== "plan") return { ok: false, error: "Preview a saved batch before queueing or cancelling it." };
   const request = Dispatch.parse(readJsonArg(args, "request"));
   const source = await db.selectFrom("digifab_library").select(["id", "file_id", "kind"]).where("id", "=", request.library_id).executeTakeFirst();
   if (!source || !["svg", "dxf"].includes(source.kind)) return { ok: false, error: "Choose a stored SVG or DXF drawing." };
   const file = await platform().files.read(ctx.orgId, source.file_id); if (!file) return { ok: false, error: "This drawing no longer exists." };
   try { parseDesign(file.filename, file.bytes, request.dxf_units); } catch (e) { throw new LaserPlanRefusal(e instanceof Error ? e.message : "The drawing cannot be read."); }
   const row = await db.insertInto("digifab_material_dispatches").values({ library_id: request.library_id, request, error: null }).returningAll().executeTakeFirstOrThrow();
   return { ok: true, ...await dispatchLaserBatch(db, ctx.orgId, row.id) };
  } catch (e) { if (e instanceof z.ZodError || e instanceof LaserPlanRefusal) return { ok: false, error: e.message }; throw e; }
 });
 platform().notifications.registerDigestContributor("inventory.low-stock", "digifab", async (orgId, raw) => {
  const db = raw as Kysely<DigifabDB>;
  const [jobs, batches, stock] = await Promise.all([db.selectFrom("digifab_jobs").select(["id", "file_ref", "status", "material_type", "material_part_id", "material_grams"]).where("status", "=", "queued").where("target_pool", "is not", null).execute(), db.selectFrom("digifab_material_dispatches").select(["id", "error", "shortage"]).where("status", "=", "blocked").where("shortage", "=", true).execute(), floorStock(orgId)]);
  return materialShortages(jobs, batches, stock);
 });
}
