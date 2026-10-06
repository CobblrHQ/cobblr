import { createHash } from "node:crypto";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { sql, type Kysely } from "kysely";
import { nestOutlines } from "../outline-nesting.js";
import { parseDesign } from "../laser-design.js";
import { generateProject, generateNestedSvg, importProfiles, ProfileSchema } from "../laser-layout.js";
import { availableSheet, idleLaser, laserBed, LaserPlanRefusal, type LaserPlan } from "../laser-plans.js";
export const Machine = z.object({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200) });
export const Plan = Machine.extend({ library_id: z.string().uuid(), quantity: z.number().int().min(1).max(10000), sheet_ids: z.array(z.string().uuid()).min(1).max(50), mapping: z.record(z.string().uuid()), spacing_mm: z.number().min(0).max(100).default(1), kerf_mm: z.number().min(0).max(100).default(0), rotate: z.boolean().default(true), rotation_step: z.number().int().min(1).max(360).refine(n => 360 % n === 0).default(90), budget_ms: z.number().int().min(100).max(30000).default(3000), seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0), dxf_units: z.enum(["mm", "in"]).default("mm") });
export async function importLaserProfiles(db: Kysely<DigifabDB>, orgId: string, body: z.infer<typeof Machine>) {
  let items: unknown[] = [];
  const locked = await platform().exclusive.run(`laser-start:${orgId}:${body.connection_id}:${body.device_id}`, async () => {
   const driver = await idleLaser(db, orgId, body.connection_id, body.device_id);
   const review = await driver.prepareJob!(Buffer.from('<?xml version="1.0"?><LightBurnProject AppVersion="1.7.03" FormatVersion="1" MaterialHeight="0" MirrorX="False" MirrorY="False"/>'), "material-library.lbrn2");
   if (review.transport !== "rest") throw new LaserPlanRefusal("LightBurn REST is needed to import the material library.");
   let profiles; try { profiles = importProfiles(review); } catch (e) { throw new LaserPlanRefusal(e instanceof Error ? e.message : "The material library could not be read."); }
   items = await db.transaction().execute(async trx => {
    const rows = [];
    const existing = await trx.selectFrom("digifab_laser_profiles").selectAll().where("connection_id", "=", body.connection_id).where("remote_device_id", "=", body.device_id).execute();
    for (const { source, ...profile } of profiles) {
     const prior = existing.find(r => source.guid ? r.source.guid === source.guid : JSON.stringify(r.source.original) === JSON.stringify(source.original));
     if (prior?.source.edited_at) { rows.push(prior); continue; }
     const values = { profile, source, updated_at: new Date() };
     rows.push(prior ? await trx.updateTable("digifab_laser_profiles").set(values).where("id", "=", prior.id).returningAll().executeTakeFirstOrThrow() : await trx.insertInto("digifab_laser_profiles").values({ ...values, connection_id: body.connection_id, remote_device_id: body.device_id }).returningAll().executeTakeFirstOrThrow());
    }
    return rows;
   });
  });
  if (!locked.ran) throw new LaserPlanRefusal("This laser is preparing another job. Wait for it to finish.");
  return { items };
}
export async function updateLaserProfile(db: Kysely<DigifabDB>, id: string, body: z.infer<typeof ProfileSchema>) {
 const before = await db.selectFrom("digifab_laser_profiles").selectAll().where("id", "=", id).executeTakeFirst();
 if (!before) throw new LaserPlanRefusal("No such material profile.");
 return await db.updateTable("digifab_laser_profiles").set({ profile: body, source: { ...before.source, edited_at: new Date().toISOString() }, updated_at: new Date() }).where("id", "=", before.id).returningAll().executeTakeFirstOrThrow();
}
export async function createLaserPlan(db: Kysely<DigifabDB>, orgId: string, body: z.input<typeof Plan>) {
  const b = Plan.parse(body);
  if (new Set(b.sheet_ids).size !== b.sheet_ids.length) throw new LaserPlanRefusal("Choose each physical sheet once.");
  const item = await db.selectFrom("digifab_library").selectAll().where("id", "=", b.library_id).executeTakeFirst();
  const file = item && await platform().files.read(orgId, item.file_id);
  if (!file) throw new LaserPlanRefusal("Choose a stored SVG or DXF drawing.");
  const records = await db.selectFrom("digifab_laser_profiles").selectAll().where("connection_id", "=", b.connection_id).where("remote_device_id", "=", b.device_id).execute();
  const profiles = Object.fromEntries(Object.entries(b.mapping).map(([layer, id]) => { const profile = records.find(r => r.id === id)?.profile; if (!profile) throw new LaserPlanRefusal("Choose a material profile on this machine for every layer."); return [layer, profile]; }));
  const sample = Object.values(profiles)[0]; if (!sample) throw new LaserPlanRefusal("Map the design layers to material profiles first.");
  if (Object.values(profiles).some(p => p.material.toLowerCase() !== sample.material.toLowerCase() || Math.abs(p.thickness_mm - sample.thickness_mm) > 0.01)) throw new LaserPlanRefusal("All operations must use the same material and thickness.");
  const sheets = await Promise.all(b.sheet_ids.map(id => availableSheet(orgId, id)));
  const bed = await laserBed(db, orgId, b.connection_id, b.device_id);
  if (sheets.some(s => s.width > bed.width || s.height > bed.height)) throw new LaserPlanRefusal("A chosen sheet exceeds the laser bed. Choose sheets that fit its saved bed size.");
  if (sheets.some(s => s.material.toLowerCase() !== sample.material.toLowerCase() || Math.abs(s.thickness_mm - sample.thickness_mm) > 0.01)) throw new LaserPlanRefusal("The chosen sheets must match the profile's material and thickness.");
  let design: import("../laser-layout.js").Design, layouts: import("../laser-layout.js").LayoutSheet[], estimated_sec: number;
  try { design = parseDesign(file.filename, file.bytes, b.dxf_units); layouts = await nestOutlines(design, b.quantity, sheets, b.spacing_mm, b.kerf_mm, b.rotate, b); estimated_sec = layouts.reduce((n, s) => n + generateProject(design, s, profiles).estimated_sec, 0); }
  catch (e) { throw new LaserPlanRefusal(e instanceof Error ? e.message : "The drawing could not be nested."); }
  const plan: LaserPlan = { name: item!.name.slice(0, 160), design, quantity: b.quantity, material: sample.material, thickness_mm: sample.thickness_mm, sheets: layouts, profiles, estimated_sec, source_hash: createHash("sha256").update(file.bytes).digest("hex") };
  const row = await db.insertInto("digifab_laser_plans").values({ connection_id: b.connection_id, remote_device_id: b.device_id, library_id: item!.id, plan, run_id: null }).returningAll().executeTakeFirstOrThrow();
  return row;
}
export async function discardLaserPlan(db: Kysely<DigifabDB>, id: string) {
 if (await db.selectFrom("digifab_material_dispatches").select("id").where("status", "in", ["planned", "blocked"]).where(sql<boolean>`plan_ids @> ${JSON.stringify([id])}::jsonb`).executeTakeFirst()) throw new LaserPlanRefusal("Withdraw its material batch to discard this layout.");
 const row = await db.deleteFrom("digifab_laser_plans").where("id", "=", id).where("run_id", "is", null).returning("id").executeTakeFirst();
 if (!row) throw new LaserPlanRefusal("Cancel the Production run to discard a queued layout.");
 return { ok: true };
}

export const NestDrawing = Plan.omit({ connection_id: true, device_id: true, mapping: true });
export async function nestDrawing(db: Kysely<DigifabDB>, orgId: string, b: z.infer<typeof NestDrawing>) {
 if (new Set(b.sheet_ids).size !== b.sheet_ids.length) throw new LaserPlanRefusal("Choose each physical sheet once.");
 const item = await db.selectFrom("digifab_library").select("file_id").where("id","=",b.library_id).executeTakeFirst();
 const file = item && await platform().files.read(orgId,item.file_id);
 if (!file) throw new LaserPlanRefusal("Choose a stored SVG or DXF drawing.");
 const sheets = await Promise.all(b.sheet_ids.map(id=>availableSheet(orgId,id)));
 try {
  const design = parseDesign(file.filename,file.bytes,b.dxf_units);
  return { design, sheets: (await nestOutlines(design,b.quantity,sheets,b.spacing_mm,b.kerf_mm,b.rotate,b)).map(s=>({...s,svg:generateNestedSvg(design,s)})), quantity: b.quantity };
 } catch (e) { throw new LaserPlanRefusal(e instanceof Error ? e.message : "The drawing could not be nested."); }
}
export const NewProfile = Machine.extend({profile: ProfileSchema});
export async function createLaserProfile(db: Kysely<DigifabDB>, orgId: string, body: z.infer<typeof NewProfile>) {
 const driver = await idleLaser(db, orgId, body.connection_id, body.device_id);
 if (!driver) throw new LaserPlanRefusal("Choose a connected laser first.");
 return db.insertInto("digifab_laser_profiles").values({ connection_id: body.connection_id, remote_device_id: body.device_id, profile: body.profile, source: { tested_on: { connection_id: body.connection_id, device_id: body.device_id }, created_in: "Cobblr" } }).returningAll().executeTakeFirstOrThrow();
}
