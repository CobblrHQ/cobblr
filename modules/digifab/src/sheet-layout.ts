// A sheet job's layout, shared by every family that cuts from sheet stock:
// the layout a job carries, the sheet it was nested on, the machine's bed, and
// the used area recorded when it finishes. A laser plan's own making and
// acceptance is the lasers family's (families/lasers/laser-plans.ts).
import polygonClipping from "polygon-clipping";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import type { LayoutAdjustments } from "./layout-adjustments.js";
import { materialFromFields } from "./laser-material.js";
import { canRecordCuts, type Design, type LayerSettings, type LayoutSheet, type Profile, type Rect, type Point, type Sheet } from "./laser-layout.js";
export class LaserPlanRefusal extends Error {}
export type LaserPlan = {
 name: string; design: Design; quantity: number; material: string; thickness_mm: number; source_hash: string;
 sheets: LayoutSheet[]; profiles: Record<string, Profile>; estimated_sec: number; adjustments?: LayoutAdjustments;
};
export type JobLayout = { plan_id: string; sheet_index: number; sheet_id: string; revision: number; quantity: number; footprints: Rect[]; outlines?: Point[][]; expected: LayerSettings[]; content_hash: string; design: Design; parts: LayoutSheet["parts"] };
export function layoutOf(metadata: Record<string, unknown>): JobLayout | null {
 const l = metadata.laser_layout as JobLayout | undefined;
 return l && typeof l.plan_id === "string" && typeof l.sheet_id === "string" && Array.isArray(l.footprints) ? l : null;
}
export async function isLayoutFile(db: Kysely<DigifabDB>, fileId: string | null | undefined): Promise<boolean> {
 return !!fileId && !!await db.selectFrom("digifab_library").select("id").where("file_id", "=", fileId).where(sql<boolean>`(metadata ? 'laser_layout' or metadata ? 'cutter_plan')`).executeTakeFirst();
}
export async function libraryForJob(db: Kysely<DigifabDB>, job: { file_id: string | null; laser_layout?: JobLayout | null }) {
 if (!job.file_id) return null;
 let query = db.selectFrom("digifab_library").selectAll().where("file_id", "=", job.file_id);
 if (job.laser_layout) query = query.where(sql<string>`metadata -> 'laser_layout' ->> 'sheet_id'`, "=", job.laser_layout.sheet_id);
 return await query.executeTakeFirst() ?? null;
}
export async function availableSheet(orgId: string, id: string): Promise<Sheet & { material: string; thickness_mm: number; name: string }> {
 const entity = await platform().entities.lookup(orgId, "inventory:part", id);
 const material = entity && !entity.retired ? materialFromFields(entity.fields) : null;
 const geometry = entity?.fields.sheet_geometry as { revision?: number; free_rectangles?: Rect[]; free_regions?: Point[][][]; used_outlines?: Point[][]; cut_capacity?: Sheet["cut_capacity"] } | undefined;
 if (!material || Number(entity?.fields.qty ?? 0) <= 0 || !geometry || !Array.isArray(geometry.free_rectangles) || typeof geometry.revision !== "number") throw new LaserPlanRefusal("Choose an available sheet with saved dimensions and free area.");
 return { id, name: entity!.title, width: material.width_mm, height: material.height_mm, revision: geometry.revision, material: material.material, thickness_mm: material.thickness_mm, free_rectangles: geometry.free_rectangles, ...(Array.isArray(geometry.free_regions) ? { free_regions: geometry.free_regions } : {}), used_outlines: geometry.used_outlines, cut_capacity: geometry.cut_capacity };
}
export async function laserBed(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string): Promise<{ width: number; height: number }> {
 const link = await db.selectFrom("digifab_device_links").select("machine_id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).executeTakeFirst();
 const machine = link && await platform().entities.lookup(orgId, "machines:machine", link.machine_id);
 const metadata = machine?.fields.metadata as Record<string, unknown> | undefined;
 const match = /^\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(?:mm)?\s*$/i.exec(String(metadata?.bed_size_laser ?? ""));
 const width = Number(match?.[1]), height = Number(match?.[2]);
 if (!machine || machine.retired || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new LaserPlanRefusal("Link this laser to its machine and save its bed size in millimetres before planning.");
 return { width, height };
}
export function layoutMismatch(layout: JobLayout, sheetId: string, geometry: { revision?: number; free_rectangles?: Rect[]; used_outlines?: Point[][]; cut_capacity?: Sheet["cut_capacity"] }): string | null {
 if (sheetId !== layout.sheet_id) return "Load the sheet chosen for this layout. A different sheet needs a new plan.";
 if (geometry.revision !== layout.revision) return "This sheet changed after nesting. Make a new plan before Start.";
 if (!canRecordCuts(geometry.cut_capacity,layout.footprints,layout.outlines)) return "This sheet cannot record all these cuts. Use fewer parts or another sheet before Start.";
 const contains = (r: Rect, b: Rect) => b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width + 1e-8 && b.y + b.height <= r.y + r.height + 1e-8;
 if (layout.outlines) {
  const ring = (p: Point[]): polygonClipping.Ring => [...p,p[0]!].map(v=>[v.x,v.y]);
  const free = geometry.free_rectangles ?? [];
  const available: polygonClipping.Polygon[] = free.map(r=>[[[r.x,r.y],[r.x+r.width,r.y],[r.x+r.width,r.y+r.height],[r.x,r.y+r.height],[r.x,r.y]]]);
  for (const outline of layout.outlines) {
   if (outline.length < 3 || outline.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) return "The nested parts have invalid outlines. Make a new plan before Start.";
   const shape: polygonClipping.Polygon = [ring(outline)];
   if (geometry.used_outlines) {
    if (geometry.used_outlines.some(p=>polygonClipping.intersection(shape,[ring(p)]).length)) return "The nested parts reach a used area. Make a new plan before Start.";
   } else if (!available.length || polygonClipping.difference(shape,...available).length) return "The nested parts reach a used area. Make a new plan before Start.";
  }
  return null;
 }
 return layout.footprints.every(b => geometry.free_rectangles?.some(r => contains(r, b))) ? null : "The nested parts reach a used area. Make a new plan before Start.";
}
export async function recordFinishedLayout(db: Kysely<DigifabDB>, orgId: string, jobId: string, userId: string | null) {
 const job = await db.selectFrom("digifab_jobs").select(["laser_layout", "status"]).where("id", "=", jobId).executeTakeFirst();
 const layout = job?.laser_layout; if (!layout || !["completed", "failed", "cancelled"].includes(job!.status)) return;
 const cuts = layout.outlines ?? layout.footprints;
 for (let offset = 0; offset < cuts.length; offset += 128) {
  const sheet = await availableSheet(orgId, layout.sheet_id);
  const result = normaliseActionResult(await platform().actions.invoke("inventory:change-sheet-area", {
   orgId, userId, entity: { kind: "inventory:part", id: layout.sheet_id }, args: { operation: "cut", revision: sheet.revision, ...(layout.outlines ? { outlines: layout.outlines.slice(offset, offset + 128) } : { rectangles: layout.footprints.slice(offset, offset + 128) }), source: `${jobId}:${offset}`, verdict: job.status === "completed" ? "good" : "scrap", kerf_mm: 0, spacing_mm: 0 },
   event: { name: "digifab.print.completed", payload: { jobId }, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" },
  }), "inventory.change-sheet-area");
  if (!result.ok) throw new LaserPlanRefusal("The cut's used area could not be recorded. Keep this sheet aside and check its record.");
 }
 await db.deleteFrom("digifab_laser_sheet_claims").where("part_id", "=", layout.sheet_id).where("plan_id", "=", layout.plan_id).execute();
}
