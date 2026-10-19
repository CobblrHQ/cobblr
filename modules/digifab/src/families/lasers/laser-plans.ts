import { recordedOutline, validateAdjustedLayout } from "../../layout-adjustments.js";
import { createHash, randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { compileLaserPlan } from "./laser-motion-plan.js";
import { generateProject, verifyLaserOutput, type LayoutSheet, type Rect } from "../../laser-layout.js";
import { buildDriverById, NOT_OCCUPYING_STATUSES } from "../../jobs-core.js";
import { availableSheet, laserBed, LaserPlanRefusal, type JobLayout } from "../../sheet-layout.js";
export async function idleLaser(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string) {
 const driver = await buildDriverById(db, orgId, connectionId);
 if (!driver?.prepareJob || !await driver.jobReviewRequired?.()) throw new LaserPlanRefusal("Choose a connected laser with job review.");
 const active = await db.selectFrom("digifab_jobs").select("id").where("connection_id", "=", connectionId).where("target_device", "=", deviceId).where("status", "not in", [...NOT_OCCUPYING_STATUSES]).executeTakeFirst();
 const attention = await db.selectFrom("digifab_device_attention").select("job_id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).executeTakeFirst();
 const device = (await driver.listDevices()).find(d => d.id === deviceId);
 if (active || attention || !device || !["idle", "ready", "operational"].includes((device.state ?? "").toLowerCase())) throw new LaserPlanRefusal("Finish the current laser job and clear its bed before preparing another project.");
 return driver;
}
export function compactFootprints(rectangles: Rect[]): Rect[] {
 const result = rectangles.map(r => ({ ...r }));
 let merged = true;
 while (merged) {
  merged = false;
  outer: for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
   const a = result[i]!, b = result[j]!;
   const close = (x: number, y: number) => Math.abs(x - y) < 1e-8;
   if (close(a.y, b.y) && close(a.height, b.height) && (close(a.x + a.width, b.x) || close(b.x + b.width, a.x))) { a.x = Math.min(a.x, b.x); a.width += b.width; }
   else if (close(a.x, b.x) && close(a.width, b.width) && (close(a.y + a.height, b.y) || close(b.y + b.height, a.y))) { a.y = Math.min(a.y, b.y); a.height += b.height; }
   else continue;
   result.splice(j, 1); merged = true; break outer;
  }
 }
 return result;
}
export async function acceptLaserPlan(db: Kysely<DigifabDB>, orgId: string, id: string) {
 let answer: {run_id:string;jobs:string[]} | undefined;
 const lock=await platform().exclusive.run(`laser-layout:${orgId}:${id}`,async()=>{answer=await acceptLockedLaserPlan(db,orgId,id);});
 if(!lock.ran||!answer)throw new LaserPlanRefusal("This layout is being adjusted. Wait for the current change to finish.");
 return answer;
}
async function acceptLockedLaserPlan(db: Kysely<DigifabDB>, orgId: string, id: string) {
 const initial = await db.selectFrom("digifab_laser_plans").selectAll().where("id", "=", id).executeTakeFirst();
 if (!initial) throw new LaserPlanRefusal("This plan no longer exists.");
 let answer: { run_id: string; jobs: string[] } | undefined;
 const locked = await platform().exclusive.run(`laser-start:${orgId}:${initial.connection_id}:${initial.remote_device_id}`, async () => {
  const saved = await db.selectFrom("digifab_laser_plans").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  if (saved.run_id) { const jobs = await db.selectFrom("digifab_jobs").select("id").where("run_id", "=", saved.run_id).execute(); answer = { run_id: saved.run_id, jobs: jobs.map(j => j.id) }; return; }
  const plan = saved.plan;
  if (plan.adjustments) validateAdjustedLayout(plan.design,plan.sheets,plan.adjustments,plan.quantity);
  const bed = await laserBed(db, orgId, saved.connection_id, saved.remote_device_id);
  if (plan.sheets.some(s => s.width > bed.width || s.height > bed.height)) throw new LaserPlanRefusal("A chosen sheet exceeds the laser bed. Choose sheets that fit its saved bed size.");
  const source = await db.selectFrom("digifab_library").select("file_id").where("id", "=", saved.library_id).executeTakeFirstOrThrow();
  const bytes = await platform().files.read(orgId, source.file_id);
  if (!bytes || createHash("sha256").update(bytes.bytes).digest("hex") !== plan.source_hash) throw new LaserPlanRefusal("The source drawing changed. Make a new plan.");
  const driver = await idleLaser(db, orgId, saved.connection_id, saved.remote_device_id);
  await db.transaction().execute(async trx => {
   for (const sheet of plan.sheets) {
    const claim = await trx.selectFrom("digifab_laser_sheet_claims").select("plan_id").where("part_id", "=", sheet.id).executeTakeFirst();
    if (claim && claim.plan_id !== id) throw new LaserPlanRefusal("A chosen sheet is reserved by another laser run. Choose another sheet.");
    await trx.insertInto("digifab_laser_sheet_claims").values({ part_id: sheet.id, plan_id: id }).onConflict(c => c.column("part_id").doNothing()).execute();
    const winner = await trx.selectFrom("digifab_laser_sheet_claims").select("plan_id").where("part_id", "=", sheet.id).executeTakeFirstOrThrow();
    if (winner.plan_id !== id) throw new LaserPlanRefusal("A chosen sheet was reserved by another laser run.");
   }
  });
  try {
   const files: Array<{ fileId: string; filename: string; size: number; sheet: LayoutSheet; layout: JobLayout }> = [];
   for (const [index, sheet] of plan.sheets.entries()) {
    const current = await availableSheet(orgId, sheet.id);
    if (current.revision !== sheet.revision || current.material.toLowerCase() !== plan.material.toLowerCase() || Math.abs(current.thickness_mm - plan.thickness_mm) > 0.01) throw new LaserPlanRefusal("A chosen sheet changed. Make a new plan before queuing.");
    const project = generateProject(plan.design, sheet, plan.profiles);
    const direct = !!driver.laserBackend;
    const content = direct ? JSON.stringify(compileLaserPlan(plan.design, sheet, plan.profiles, bed)) : project.xml;
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new LaserPlanRefusal("This sheet produces a project over 20 MB. Make a smaller batch.");
    const filename = `laser-${id}-${index + 1}.${direct ? "laserplan" : "lbrn2"}`;
    const content_hash = createHash("sha256").update(content).digest("hex");
    if (!direct) {
     const review = await driver.prepareJob!(Buffer.from(content), filename);
     try { verifyLaserOutput(project.layers, review); if (review.contentHash !== content_hash) throw new Error("The laser driver reviewed a different file."); }
     catch (e) { throw new LaserPlanRefusal(e instanceof Error ? e.message : "The generated project could not be verified."); }
    }
    const file = await platform().files.write(orgId, Buffer.from(content), { filename, mimeType: direct ? "application/json" : "application/xml" });
    if (!file) throw new LaserPlanRefusal("The generated file could not be saved.");
    const outlines = sheet.nesting === "outline" || plan.adjustments ? sheet.parts.map(recordedOutline) : undefined;
    const footprints = outlines ? [] : compactFootprints(sheet.parts.map(p => p.footprint));
    if (footprints.length > 512) throw new LaserPlanRefusal("This layout is too fragmented to record its used area. Make a smaller batch.");
    files.push({ fileId: file.fileId, filename, size: Buffer.byteLength(content), sheet, layout: { plan_id: id, sheet_index: index, sheet_id: sheet.id, revision: sheet.revision, quantity: sheet.parts.filter(p=>!p.extra).length, footprints, ...(outlines ? { outlines } : {}), expected: project.layers, content_hash, design: plan.design, parts: sheet.parts } });
   }
   answer = await db.transaction().execute(async trx => {
    const claim = await trx.selectFrom("digifab_laser_plans").select("run_id").where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
    if (claim.run_id) throw new LaserPlanRefusal("This plan was already queued.");
    const runId = randomUUID();
    const pool = await trx.insertInto("digifab_pools").values({ name: plan.name.slice(0, 120), config: { run_id: runId } }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("digifab_pool_members").values({ pool_id: pool.id, connection_id: saved.connection_id, remote_device_id: saved.remote_device_id }).execute();
    const run = await trx.insertInto("digifab_production_runs").values({ id: runId, name: plan.name, pool_id: pool.id, file_id: source.file_id, file_ref: plan.name, target_qty: plan.quantity, laser_plan_id: id, material_part_id: null, material_grams: null, linked_build_id: null }).returning("id").executeTakeFirstOrThrow();
    const jobs: string[] = [];
    for (const f of files) {
     const displayName = `${plan.name} · Sheet ${files.indexOf(f) + 1}`;
     const metadata = { laser_material: { material: plan.material, thickness_mm: plan.thickness_mm, width_mm: f.sheet.width, height_mm: f.sheet.height }, laser_layout: f.layout, parts_per_plate: f.sheet.parts.filter(p=>!p.extra).length };
     await trx.insertInto("digifab_library").values({ name: displayName, file_id: f.fileId, thumbnail_file_id: null, kind: f.filename.endsWith(".laserplan") ? "laser-plan" : "lbrn2", size_bytes: f.size, plate_count: 1, notes: "Generated from a verified laser layout.", metadata }).execute();
     const job = await trx.insertInto("digifab_jobs").values({ connection_id: saved.connection_id, target_device: saved.remote_device_id, file_id: f.fileId, file_ref: f.filename, run_id: run.id, metadata: { display_name: displayName }, laser_layout: f.layout, max_attempts: 1 }).returning("id").executeTakeFirstOrThrow();
     jobs.push(job.id);
    }
    await trx.updateTable("digifab_laser_plans").set({ run_id: run.id }).where("id", "=", id).execute();
    return { run_id: run.id, jobs };
   });
  } catch (e) { await db.deleteFrom("digifab_laser_sheet_claims").where("plan_id", "=", id).execute(); throw e; }
 });
 if (!locked.ran || !answer) throw new LaserPlanRefusal("This laser is preparing another job. Wait for that preparation to finish.");
 return answer;
}
