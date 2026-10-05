import { Router } from "express";
import { z } from "zod";
import { type Kysely, type Selectable, sql } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { tenantDb, tenantContext, instanceOf, sessionUser, type InventoryDB } from "../db.js";
import { emptySheetState, sheetSpec, sheetArea, recordCut, editFreeArea, undoFreeEdit, fitsSheet, type SheetState } from "../sheet-area.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

const RectSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive() });
const Change = z.object({ operation: z.enum(["cut", "edit", "undo"]), revision: z.number().int().nonnegative(), rectangles: z.array(RectSchema).max(128).optional(), kerf_mm: z.number().finite().nonnegative().max(1000).default(0), spacing_mm: z.number().finite().nonnegative().max(1000).default(0), source: z.string().min(1).max(160).optional(), partId: z.string().uuid().optional() });
export type SheetChange = z.input<typeof Change>;
type Part = Selectable<InventoryDB["inventory_parts"]>;

export function sheetView(row: Part, state: SheetState, revision: number) {
  const spec = sheetSpec(row.metadata ?? {});
  return spec ? { id: row.id, name: row.name, kind: row.instance === "inventory" ? "inventory:part" : `${row.instance}:item`, instance: row.instance, spec, revision, can_undo: state.edits.length > 0, ...sheetArea(spec, state) } : null;
}
export async function sheetViews(db: Kysely<InventoryDB>, rows: Part[]) {
  const sheets = rows.filter(r => sheetSpec(r.metadata ?? {}));
  if (!sheets.length) return new Map<string, NonNullable<ReturnType<typeof sheetView>>>();
  const states = await db.selectFrom("inventory_sheet_area").selectAll().where("part_id", "in", sheets.map(r => r.id)).execute();
  const byId = new Map(states.map(s => [s.part_id, s]));
  return new Map(sheets.map(r => { const stored = byId.get(r.id); return [r.id, sheetView(r, stored?.state ?? emptySheetState(), stored?.revision ?? 0)!]; }));
}

export const sheetRouter = Router({ mergeParams: true });
sheetRouter.get("/:id/sheet", asyncHandler(async (req, res) => {
  const row = await tenantDb(req).selectFrom("inventory_parts").selectAll().where("id", "=", String(req.params.id)).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  res.json((await sheetViews(tenantDb(req), [row])).get(row.id) ?? null);
}));

// AI-REACH: action inventory:change-sheet-area
sheetRouter.post("/:id/sheet", asyncHandler(async (req, res) => {
  if (!await requireCapability(req, res, "inventory:update-part")) return;
  const body = Change.safeParse(req.body);
  if (!body.success) return void badBody(res, body.error);
  const row = await tenantDb(req).selectFrom("inventory_parts").select("id").where("id", "=", String(req.params.id)).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  let result;
  try { result = normaliseActionResult(await platform().actions.invoke("inventory:change-sheet-area", {
    orgId: tenantContext(req).org.id, userId: sessionUser(req).id, entity: { kind: "inventory:part", id: row.id }, args: body.data,
    event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
  }), "inventory.change-sheet-area"); } catch (e) {
    if (!(e instanceof ActionRefusal)) throw e;
    return void res.status(409).json({ error: { code: "area_changed", message: e.message } });
  }
  if (!result.ok) return void res.status(409).json({ error: { code: "area_changed", message: typeof result.error === "string" ? result.error : "This sheet changed. Reload it before saving." } });
  const fresh = await tenantDb(req).selectFrom("inventory_parts").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
  res.json((await sheetViews(tenantDb(req), [fresh])).get(row.id));
}));

export const sheetSearchRouter = Router({ mergeParams: true });
sheetSearchRouter.get("/find", asyncHandler(async (req, res) => {
  const p = z.object({ material: z.string().trim().min(1).max(120), thickness_mm: z.coerce.number().positive().max(1000), width_mm: z.coerce.number().positive().max(100000), height_mm: z.coerce.number().positive().max(100000), rotate: z.enum(["true", "false"]).default("true"), offset: z.coerce.number().int().nonnegative().default(0) }).safeParse(req.query);
  if (!p.success) return void badBody(res, p.error);
  const db = tenantDb(req);
  const rows = await db.selectFrom("inventory_parts").selectAll().where("archived", "=", false).where("state", "=", "active").where("qty", ">", "0")
    .where(sql<boolean>`lower(coalesce(metadata->>'material',metadata->'laser_sheet'->>'material')) = ${p.data.material.toLowerCase()}`).execute();
  const views = await sheetViews(db, rows);
  const matches = [...views.values()].filter(v => Math.abs(v.spec.thickness_mm - p.data.thickness_mm) <= 0.01 && fitsSheet(v, p.data.width_mm, p.data.height_mm, p.data.rotate === "true"))
    .sort((a, b) => Number(b.offcut) - Number(a.offcut) || a.percent_left - b.percent_left || a.name.localeCompare(b.name));
  res.json({ items: matches.slice(p.data.offset, p.data.offset + 50), total: matches.length });
}));

export function registerSheetActions() {
  platform().actions.registerHandler("inventory.change-sheet-area", async ctx => {
    const parsed = Change.safeParse(ctx.args);
    if (!parsed.success) throw new ActionRefusal(parsed.error.issues[0]?.message ?? "Give the sheet area change.");
    const id = ctx.entity?.id ?? parsed.data.partId;
    if (!id) throw new ActionRefusal("Choose a sheet.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    return await db.transaction().execute(async trx => {
        const row = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
        if (!row || row.archived || row.state !== "active" || Number(row.qty) <= 0) throw new ActionRefusal("Choose an available sheet.");
        const spec = sheetSpec(row.metadata ?? {});
        if (!spec) throw new ActionRefusal("Save the material, thickness and size first.");
        const stored = await trx.selectFrom("inventory_sheet_area").selectAll().where("part_id", "=", id).executeTakeFirst();
        const state = stored?.state ?? emptySheetState();
        const revision = stored?.revision ?? 0;
        const p = parsed.data;
        if (p.operation === "cut" && p.source && state.sources.includes(p.source)) return { ok: true };
        if (p.revision !== revision) throw new ActionRefusal("This sheet changed. Reload it before saving.");
        let next;
        try { next = p.operation === "undo" ? undoFreeEdit(state) : p.operation === "edit" ? editFreeArea(spec, state, p.rectangles ?? []) : recordCut(spec, state, p.rectangles ?? [], p.kerf_mm, p.spacing_mm, p.source); }
        catch (e) { if (e instanceof Error) throw new ActionRefusal(e.message); throw e; }
        await trx.insertInto("inventory_sheet_area").values({ part_id: id, revision: revision + 1, state: next }).onConflict(oc => oc.column("part_id").doUpdateSet({ revision: revision + 1, state: next, updated_at: new Date() })).execute();
        return { ok: true, changed: true, before: { revision }, data: { revision: revision + 1 } };
    });
  });
}
