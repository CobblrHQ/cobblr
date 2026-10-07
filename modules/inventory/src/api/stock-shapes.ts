import { Router } from "express";
import { z } from "zod";
import { sql, type Kysely, type Selectable } from "kysely";
import { ActionRefusal, likeEscape, platform, readJsonArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { pagedAnswer, readListPage } from "@cobblr/platform-contract/list-page";
import { tenantDb, tenantContext, sessionUser, type InventoryDB } from "../db.js";
import { StockConfig, stockReading, consumeAmount } from "../stock-shapes.js";
import { sheetSpec, emptySheetState, sheetArea, recordCut } from "../sheet-area.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";
import { stockTrackerAllows } from "../stock-tracker.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

type Part = Pick<Selectable<InventoryDB["inventory_parts"]>, "id" | "name" | "unit" | "metadata" | "instance" | "stock_revision"> & { qty: string | number; min_qty: string | number | null };
type Saved = Selectable<InventoryDB["inventory_stock"]>;
const PartId = z.string().uuid();
const Revision = z.number().int().nonnegative();
const Rect = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), height: z.number().finite().positive() });
export const ConfigureStock = z.object({ config: StockConfig, revision: Revision, remaining: z.number().finite().nonnegative().max(999999999).optional(), used: z.number().finite().nonnegative().max(999999999).optional(), sheet: z.object({ material: z.string().trim().min(1).max(120), thickness_mm: z.number().finite().positive().max(100000), width_mm: z.number().finite().positive().max(100000), height_mm: z.number().finite().positive().max(100000) }).optional() });
export const ConsumeStock = z.object({ revision: Revision.optional(), source: z.string().trim().min(1).max(160), verdict: z.enum(["good", "scrap"]), amount: z.number().finite().positive().max(999999999).optional(), unit: z.string().min(1).max(20).optional(), waste: z.number().finite().nonnegative().max(999999999).optional(), rectangles: z.array(Rect).min(1).max(128).optional(), kerf_mm: z.number().finite().nonnegative().max(1000).default(0), spacing_mm: z.number().finite().nonnegative().max(1000).default(0) });
export const LoadStock = z.object({ station: z.string().trim().min(1).max(160), slot: z.string().trim().min(1).max(80).default("stock"), loaded: z.boolean().default(true) });

export function stockView(row: Part, saved?: Saved, area?: { state: import("../sheet-area.js").SheetState; revision: number }) {
  const spec = sheetSpec(row.metadata ?? {});
  const config = saved?.config ?? StockConfig.parse(spec ? { shape: "sheet" } : { shape: "count", low_threshold: Math.max(0, Number(row.min_qty ?? 0)) });
  const sheet = config.shape === "sheet" && spec ? { spec, ...sheetArea(spec, area?.state ?? emptySheetState()), revision: area?.revision ?? 0 } : undefined;
  const reading = stockReading(config, Number(row.qty), Number(saved?.used ?? 0), sheet);
  return { id: row.id, name: row.name, instance: row.instance, kind: row.instance === "inventory" ? "inventory:part" : `${row.instance}:item`,
    ...reading, config, revision: (row.stock_revision ?? 0) + (saved?.revision ?? 0) + (sheet?.revision ?? 0), configured: !!saved,
    ...(config.shape === "count" ? { unit: row.unit } : {}),
    ...(config.shape !== "sheet" && config.shape !== "wearing-tool" ? { low_threshold: Number(row.min_qty ?? 0), low: reading.remaining <= Number(row.min_qty ?? 0) } : {}) };
}
export type StockView = ReturnType<typeof stockView>;
export async function stockViews(db: Kysely<InventoryDB>, rows: readonly Part[]) {
  if (!rows.length) return new Map<string, StockView>();
  const ids = rows.map(r => r.id);
  const [saved, areas] = await Promise.all([
    db.selectFrom("inventory_stock").selectAll().where("part_id", "in", ids).execute(),
    db.selectFrom("inventory_sheet_area").selectAll().where("part_id", "in", ids).execute(),
  ]);
  const configs = new Map(saved.map(r => [r.part_id, r]));
  const sheets = new Map(areas.map(r => [r.part_id, r]));
  return new Map(rows.map(r => [r.id, stockView(r, configs.get(r.id), sheets.get(r.id))]));
}

export const shapedStockRouter = Router({ mergeParams: true });
const StockList = z.object({ q: z.string().max(200).optional(), shape: z.enum(["sheet", "roll", "spool", "liquid", "wearing-tool", "count"]).optional(), station: z.string().max(160).optional() });
async function listStock(db: Kysely<InventoryDB>, asked: unknown) {
  const q = StockList.parse(asked);
  const { limit, offset } = readListPage(asked);
  let query = db.selectFrom("inventory_parts as p").leftJoin("inventory_stock as s", "s.part_id", "p.id").selectAll("p").where("p.archived", "=", false).where("p.state", "=", "active");
  if (q.q) query = query.where("p.name", "ilike", `%${likeEscape(q.q)}%`);
  if (q.shape) query = query.where(sql<string>`coalesce(s.shape, case when p.metadata ? 'laser_sheet' or (p.metadata ? 'material' and p.metadata ? 'width_mm') then 'sheet' else 'count' end)`, "=", q.shape);
  const [rows, count, loaded] = await Promise.all([
    query.orderBy("p.name").orderBy("p.id").limit(limit).offset(offset).execute(),
    query.clearSelect().select(sql<string>`count(*)`.as("total")).executeTakeFirstOrThrow(),
    q.station ? db.selectFrom("inventory_stock_loaded").selectAll().where("station", "=", q.station).execute() : Promise.resolve([]),
  ]);
  const views = await stockViews(db, rows);
  return { ...pagedAnswer([...views.values()].map(v => ({ ...v, __list_total: count.total })), { limit, offset }), total: Number(count.total), complete: offset + rows.length >= Number(count.total), loaded };
}
// AI-REACH: action inventory:list-stock
shapedStockRouter.get("/", asyncHandler(async (req, res) => {
  const q = StockList.safeParse(req.query);
  if (!q.success) return void badBody(res, q.error);
  res.json(await listStock(tenantDb(req), req.query));
}));
shapedStockRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = PartId.safeParse(req.params.id);
  if (!id.success) return void badBody(res, id.error);
  const db = tenantDb(req);
  const row = await db.selectFrom("inventory_parts").selectAll().where("id", "=", id.data).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such stock." } });
  const [views, uses, loaded] = await Promise.all([
    stockViews(db, [row]),
    db.selectFrom("inventory_stock_uses").selectAll().where("part_id", "=", row.id).orderBy("at", "desc").limit(50).execute(),
    db.selectFrom("inventory_stock_loaded").selectAll().where("part_id", "=", row.id).executeTakeFirst(),
  ]);
  res.json({ ...views.get(row.id), uses, loaded: loaded ?? null });
}));

async function routeWrite(req: Parameters<typeof tenantDb>[0], res: import("express").Response, action: string, schema: typeof ConfigureStock | typeof ConsumeStock | typeof LoadStock) {
  if (!await requireCapability(req, res, "inventory:update-part")) return;
  const body = schema.safeParse(req.body);
  const id = PartId.safeParse(req.params.id);
  if (!body.success) return void badBody(res, body.error);
  if (!id.success) return void badBody(res, id.error);
  try {
    const out = normaliseActionResult(await platform().actions.invoke(action, {
      orgId: tenantContext(req).org.id, userId: sessionUser(req).id, entity: { kind: "inventory:part", id: id.data }, args: { fields: body.data },
      event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
    }), action);
    if (!out.ok) return void res.status(409).json({ error: { code: "stock_refused", message: typeof out.error === "string" ? out.error : "The stock change could not be saved." } });
    res.json(out);
  } catch (e) {
    if (!(e instanceof ActionRefusal)) throw e;
    res.status(409).json({ error: { code: "stock_refused", message: e.message } });
  }
}
// AI-REACH: action inventory:configure-stock
shapedStockRouter.patch("/:id", asyncHandler(async (req, res) => routeWrite(req, res, "inventory:configure-stock", ConfigureStock)));
// AI-REACH: action inventory:consume-stock
shapedStockRouter.post("/:id/consume", asyncHandler(async (req, res) => routeWrite(req, res, "inventory:consume-stock", ConsumeStock)));
// AI-REACH: action inventory:load-stock
shapedStockRouter.post("/:id/load", asyncHandler(async (req, res) => routeWrite(req, res, "inventory:load-stock", LoadStock)));

function fields(ctx: ActionInvokeContext) { return readJsonArg(ctx.args ?? {}, "fields") ?? ctx.args ?? {}; }
function idOf(value: unknown) {
  const p = PartId.safeParse(value);
  if (!p.success) throw new ActionRefusal("Choose stock in this workspace.");
  return p.data;
}
async function locked(db: Kysely<InventoryDB>, id: string, allowTracked = false) {
  const row = await db.selectFrom("inventory_parts").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
  if (!row || row.archived || row.state !== "active") throw new ActionRefusal("Choose available stock.");
  if (!allowTracked && !stockTrackerAllows(typeof row.metadata?.tracked_by === "string" ? row.metadata.tracked_by : null)) throw new ActionRefusal("Its usage tracker keeps this stock amount. Update it there.");
  return row;
}
function refuse(error: unknown): never {
  if (error instanceof z.ZodError) throw new ActionRefusal(error.issues[0]?.message ?? "Check the stock fields.");
  if (error instanceof Error) throw new ActionRefusal(error.message);
  throw error;
}
async function maintenance(ctx: ActionInvokeContext, view: StockView) {
  if (view.config.shape !== "wearing-tool") return undefined;
  try {
    const result = normaliseActionResult(await platform().actions.invoke("core-maintenance:ensure-usage", {
      ...ctx, entity: { kind: view.kind, id: view.id }, args: { name: `Replace ${view.name}`, counter_field: "stock_used", counter_every: view.config.limit },
    }), "core-maintenance.ensure-usage");
    return result.ok ? undefined : "Stock use was saved. Enable Maintenance to track this tool's replacement.";
  } catch (e) {
    console.error("[inventory] stock maintenance could not be reconciled:", e instanceof Error ? e.message : "unknown error");
    return "Stock use was saved. Its maintenance schedule could not be checked.";
  }
}

export function registerShapedStockActions() {
  // A read leaves no changes to undo, and may run without a confirm card.
  platform().actions.registerUndo("inventory.list-stock", () => null);
  platform().actions.registerHandler("inventory.list-stock", async ctx => {
    const asked = fields(ctx);
    const parsed = StockList.safeParse(asked);
    if (!parsed.success) return refuse(parsed.error);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    return { ok: true, changed: false, data: await listStock(db, asked) };
  });
  platform().actions.registerHandler("inventory.configure-stock", async ctx => {
    let p: z.infer<typeof ConfigureStock>;
    try { p = ConfigureStock.parse(fields(ctx)); } catch (e) { return refuse(e); }
    const id = idOf(ctx.entity?.id ?? ctx.args?.partId), db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const out = await db.transaction().execute(async trx => {
      const row = await locked(trx, id);
      const current = (await stockViews(trx, [row])).get(id)!;
      if (p.revision !== current.revision) throw new ActionRefusal("This stock changed. Reload it before saving.");
      const hasUses = await trx.selectFrom("inventory_stock_uses").select("id").where("part_id", "=", id).executeTakeFirst();
      if (hasUses && p.used != null && p.used < current.used) throw new ActionRefusal("Keep this tool's accumulated use. A replacement tool gets a new stock record.");
      const area = await trx.selectFrom("inventory_sheet_area").select("state").where("part_id", "=", id).executeTakeFirst();
      if ((hasUses || area?.state.used.length) && (p.config.shape !== current.shape || p.config.shape !== "sheet" && p.config.shape !== "count" && p.config.unit !== current.unit)) throw new ActionRefusal("This stock has usage history. Keep its shape and unit, or create another record.");
      const saved = await trx.selectFrom("inventory_stock").selectAll().where("part_id", "=", id).executeTakeFirst();
      await trx.insertInto("inventory_stock").values({ part_id: id, config: p.config, used: String(p.config.shape === "wearing-tool" ? p.used ?? Number(saved?.used ?? 0) : 0), revision: (saved?.revision ?? 0) + 1 })
        .onConflict(oc => oc.column("part_id").doUpdateSet({ config: p.config, used: String(p.config.shape === "wearing-tool" ? p.used ?? Number(saved?.used ?? 0) : 0), revision: (saved?.revision ?? 0) + 1, updated_at: new Date() })).execute();
      if (p.config.shape === "sheet") {
        if (p.sheet && area?.state.used.length) {
          const before = sheetSpec(row.metadata ?? {});
          if (!before || ["width_mm", "height_mm", "thickness_mm", "material"].some(k => p.sheet![k as keyof typeof p.sheet] !== before[k as keyof typeof before])) throw new ActionRefusal("A cut sheet keeps its original material and dimensions.");
        }
        const metadata = { ...row.metadata, ...(p.sheet ?? {}) };
        if (!sheetSpec(metadata)) throw new ActionRefusal("Save the sheet's material, thickness, width and height.");
        await trx.updateTable("inventory_parts").set({ metadata, updated_at: new Date() }).where("id", "=", id).execute();
      } else if (p.config.shape !== "wearing-tool") {
        const nextUnit = p.config.shape === "count" && current.shape === "count" ? row.unit : p.config.unit;
        if (row.unit !== nextUnit && p.remaining == null) throw new ActionRefusal("Give the remaining amount in the new stock unit.");
        const qty = p.remaining ?? Number(row.qty);
        if (p.config.shape === "count" && !Number.isInteger(qty)) throw new ActionRefusal("Count whole units.");
        await trx.updateTable("inventory_parts").set({ qty: String(qty), unit: nextUnit, min_qty: String(p.config.low_threshold), updated_at: new Date() }).where("id", "=", id).execute();
        if (qty !== Number(row.qty) || row.unit !== nextUnit) await recordConsumption(trx, { partId: id, delta: row.unit === nextUnit ? qty - Number(row.qty) : qty, kind: "correction", reason: "Stock recount", unit: nextUnit, byUser: ctx.userId });
      }
      const fresh = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return { before: current, view: (await stockViews(trx, [fresh])).get(id)! };
    });
    if (out.view.shape !== "sheet" && out.view.shape !== "wearing-tool") await stockMoved(db, ctx.orgId, { partId: id, delta: out.view.remaining - Number(out.before.remaining), newQty: out.view.remaining, minQty: out.view.low_threshold, ledger: false, announceLow: false });
    return { ok: true, changed: true, before: out.before, data: out.view, warning: await maintenance(ctx, out.view) };
  });

  platform().actions.registerHandler("inventory.consume-stock", async ctx => {
    let p: z.infer<typeof ConsumeStock>;
    try { p = ConsumeStock.parse(fields(ctx)); } catch (e) { return refuse(e); }
    const id = idOf(ctx.entity?.id ?? ctx.args?.partId), db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const out = await db.transaction().execute(async trx => {
      const row = await locked(trx, id);
      const before = (await stockViews(trx, [row])).get(id)!;
      const duplicate = await trx.selectFrom("inventory_stock_uses").selectAll().where("part_id", "=", id).where("source", "=", p.source).executeTakeFirst();
      if (duplicate) return { before, view: before, duplicate: true };
      // A use is an amount off what the locked row holds now, so a reading
      // another job moved since is no reason to refuse it: two jobs that read
      // the roll before either finished both record their use. A sheet is
      // different: its cut was placed against one used-area state.
      if (p.revision !== undefined && before.config.shape === "sheet" && p.revision !== before.revision) throw new ActionRefusal("This sheet changed. Reload it before recording a cut.");
      let amount: number;
      if (before.config.shape === "sheet") {
        if (before.remaining <= 0) throw new ActionRefusal("This sheet has nothing usable left.");
        const spec = sheetSpec(row.metadata ?? {});
        if (!spec || !p.rectangles) throw new ActionRefusal("Give the sheet's used rectangles.");
        const old = await trx.selectFrom("inventory_sheet_area").selectAll().where("part_id", "=", id).executeTakeFirst();
        let state;
        try { state = recordCut(spec, old?.state ?? emptySheetState(), p.rectangles, p.kerf_mm, p.spacing_mm, p.source); } catch (e) { return refuse(e); }
        const next = sheetArea(spec, state);
        amount = before.remaining - stockReading(before.config, Number(row.qty), 0, { spec, ...next }).remaining;
        await trx.insertInto("inventory_sheet_area").values({ part_id: id, revision: (old?.revision ?? 0) + 1, state }).onConflict(oc => oc.column("part_id").doUpdateSet({ revision: (old?.revision ?? 0) + 1, state, updated_at: new Date() })).execute();
      } else {
        let use;
        try { use = consumeAmount(before.config, Number(row.qty), before.used, { amount: p.amount ?? 0, unit: p.unit === before.unit ? before.config.unit : p.unit ?? before.config.unit, waste: p.waste }); } catch (e) { return refuse(e); }
        amount = use.amount;
        if (before.config.shape === "wearing-tool") {
          await trx.updateTable("inventory_stock").set({ used: String(use.used), revision: sql<number>`revision + 1`, updated_at: new Date() }).where("part_id", "=", id).execute();
        } else {
          await trx.updateTable("inventory_parts").set({ qty: String(use.remaining), updated_at: new Date() }).where("id", "=", id).execute();
          await recordConsumption(trx, { partId: id, delta: -amount, reason: `${p.verdict === "scrap" ? "Scrap" : "Job"}: ${p.source}`, sourceKind: "stock-job", sourceId: p.source, unit: before.unit, byUser: ctx.userId });
          await trx.insertInto("inventory_stock").values({ part_id: id, config: before.config, revision: 1 }).onConflict(oc => oc.column("part_id").doUpdateSet({ revision: sql<number>`inventory_stock.revision + 1`, updated_at: new Date() })).execute();
        }
      }
      const fresh = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      const view = (await stockViews(trx, [fresh])).get(id)!;
      // check-then-insert: the part row is locked before the source lookup, serializing writers for this stock.
      await trx.insertInto("inventory_stock_uses").values({ part_id: id, source: p.source, verdict: p.verdict, amount: String(amount), unit: view.unit, remaining: String(view.remaining), by_user: ctx.userId ?? null }).execute();
      return { before, view, duplicate: false };
    });
    if (!out.duplicate && out.view.shape !== "sheet" && out.view.shape !== "wearing-tool") await stockMoved(db, ctx.orgId, { partId: id, delta: out.view.remaining - out.before.remaining, newQty: out.view.remaining, minQty: out.view.low_threshold, ledger: false });
    return { ok: true, changed: !out.duplicate, before: out.before, data: out.view, duplicate: out.duplicate, warning: await maintenance(ctx, out.view) };
  });

  platform().actions.registerHandler("inventory.load-stock", async ctx => {
    let p: z.infer<typeof LoadStock>;
    try { p = LoadStock.parse(fields(ctx)); } catch (e) { return refuse(e); }
    if (!ctx.userId) throw new ActionRefusal("Sign in to confirm what is loaded.");
    const id = idOf(ctx.entity?.id ?? ctx.args?.partId), db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    return db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtext(${"stock-loading"}))`.execute(trx);
      const row = await locked(trx, id, true);
      const view = (await stockViews(trx, [row])).get(id)!;
      if (p.loaded && view.remaining <= 0) throw new ActionRefusal("This stock has nothing usable left. Recount it or load another record.");
      let remove = trx.deleteFrom("inventory_stock_loaded").where("part_id", "=", id);
      if (!p.loaded) remove = remove.where("station", "=", p.station).where("slot", "=", p.slot);
      await remove.execute();
      if (p.loaded) await trx.insertInto("inventory_stock_loaded").values({ station: p.station, slot: p.slot, part_id: id, by_user: ctx.userId! }).onConflict(oc => oc.columns(["station", "slot"]).doUpdateSet({ part_id: id, by_user: ctx.userId!, loaded_at: new Date() })).execute();
      return { ok: true, changed: true, data: { ...view, loaded: p.loaded ? { station: p.station, slot: p.slot } : null } };
    });
  });
}
