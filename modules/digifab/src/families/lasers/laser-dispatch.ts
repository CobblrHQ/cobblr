// The floor's laser batch: a saved drawing dispatched across the lasers that
// have its material's profiles, nested onto the floor's sheets, previewed as
// layouts and queued as one run per laser (digifab.dispatch-material). The
// batch row, the stock and the floor screen are the core's (floor-manager.ts).
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../db.js";
import { parseDesign } from "./laser-design.js";
import { laserBed, LaserPlanRefusal } from "../../sheet-layout.js";
import { buildDriverById, NOT_OCCUPYING_STATUSES } from "../../jobs-core.js";
import { familyManagedDevices } from "../../core/families.js";
import { allocateOutlineLaserBatch, type LaserCandidate } from "../../material-dispatch.js";
import { Dispatch, floorStock, type DispatchRequest } from "../../floor-manager.js";
import { acceptLaserPlan } from "./laser-plans.js";
import { createLaserPlan } from "./api/laser-writes.js";
async function laserCandidates(db: Kysely<DigifabDB>, orgId: string, request: DispatchRequest): Promise<LaserCandidate[]> {
 const profiles = await db.selectFrom("digifab_laser_profiles").select(["id", "profile", "connection_id", "remote_device_id"]).execute();
 const matching = profiles.filter(p => p.profile.material.toLowerCase() === request.material.toLowerCase() && Math.abs(p.profile.thickness_mm - request.thickness_mm) < 0.01);
 const devices = [...new Map(matching.map(p => [`${p.connection_id}:${p.remote_device_id}`, p])).values()];
 const result: LaserCandidate[] = [];
 const active = await db.selectFrom("digifab_jobs").select(["connection_id", "target_device"]).where("status", "not in", [...NOT_OCCUPYING_STATUSES]).execute();
 const owned = await familyManagedDevices(db);
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
    try { allocation = await allocateOutlineLaserBatch(design, batch.request, await laserCandidates(db, orgId, batch.request), stock.sheets.filter(s => !claims.has(s.id))); } catch (e) { if (e instanceof Error) throw new LaserPlanRefusal(e.message); throw e; }
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
export function registerLaserDispatchAction(): void {
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
}
