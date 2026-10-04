import { materialMetadata, materialPrice } from "../material-price.js";
import { materialTotals } from "./material-ledger.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import { instanceOf, sessionUser, tenantContext, tenantDb, type InventoryDB } from "../db.js";
import { materialNumbers, weightFromLength, weightFromScale } from "../material-numbers.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

export const materialRouter = Router({ mergeParams: true });
const number = (v: unknown): number | null => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

async function maySeeMaterialCosts(req: Request) {
  const ctx = tenantContext(req);
  return platform().auth.userHasCapability({ orgId: ctx.org.id, userId: sessionUser(req).id, role: ctx.role, actionId: "inventory:view-costs" });
}

export async function materialView(db: Kysely<InventoryDB>, orgId: string, id: string, viewCosts = false) {
  const row = await db.selectFrom("inventory_parts").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const pairs = await platform().pairings.findBySources({ orgId, sourceKind: "inventory:part", sourceIds: [id], targetKind: "inventory:part", relationshipKind: "instance-of" });
  const type = pairs[0] ? await db.selectFrom("inventory_parts").select(["metadata"]).where("id", "=", pairs[0].targetId).executeTakeFirst() : null;
  let md = materialMetadata(type?.metadata ?? {}, row.metadata ?? {});
  if (typeof md.vendor_id === "string") {
    const vendor = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", md.vendor_id).where("instance", "=", "filament-vendors").executeTakeFirst();
    md = materialMetadata(vendor?.metadata ?? {}, Object.fromEntries(Object.entries(md).filter(([, v]) => v != null && v !== "")));
  }
  const density = number(md.density);
  const diameter = typeof md.diameter === "string" ? number(parseFloat(md.diameter)) : number(md.diameter);
  const tare = number(md.empty_spool_g);
  const multiplier = await platform().units.convert(orgId, 1, row.unit, "g");
  if (multiplier == null || !Number.isFinite(multiplier)) return null;
  const ledger = await db.selectFrom("inventory_consumption").select(["delta", "kind", "at", "reason", "source_kind", "source_id"]).where("part_id", "=", id).orderBy("at", "desc").limit(200).execute();
  const place = await platform().placement.containerOf({ orgId, containee: { kind: "inventory:part", id } });
  const total = (await materialTotals(db, [id])).get(id);
  const summary = materialNumbers(Number(row.qty) * multiplier, number(md.initial_g), density, diameter,
    [{ delta: Number(total?.net ?? 0) * multiplier, kind: null, at: "" }]);
  summary.first_used = total?.first_used ? new Date(total.first_used).toISOString() : null;
  summary.last_used = total?.last_used ? new Date(total.last_used).toISOString() : null;
  const price = viewCosts ? materialPrice(md, await platform().money.currency(orgId)) : null;
  return {
    ...summary,
    spool_id: row.asset_id, density, diameter, empty_spool_g: tare, place, price_per_kg: price,
    jobs: ledger.filter((r) => r.source_id != null).map((r) => ({ ...r, estimated_cost: price ? { amount: -Number(r.delta) * multiplier / 1000 * price.amount, currency: price.currency } : null })),
    tracked_by: typeof md.tracked_by === "string" ? md.tracked_by : null,
  };
}

materialRouter.get("/:id/material", asyncHandler(async (req, res) => {
  const db = tenantDb(req);
  const row = await db.selectFrom("inventory_parts").select("id").where("id", "=", String(req.params.id)).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  res.json(await materialView(db, tenantContext(req).org.id, row.id, await maySeeMaterialCosts(req)));
}));

const Measure = z.object({ gross_g: z.number().finite().nonnegative().optional(), used_mm: z.number().finite().positive().optional() }).refine((v) => (v.gross_g != null) !== (v.used_mm != null), "Give a scale reading or a used length.");
// AI-REACH: action inventory:measure-material
materialRouter.post("/:id/material", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:measure-material"))) return;
  const p = Measure.safeParse(req.body);
  if (!p.success) return void badBody(res, p.error);
  const row = await tenantDb(req).selectFrom("inventory_parts").select("id").where("id", "=", String(req.params.id)).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  const result = await platform().actions.invoke("inventory:measure-material", { orgId: tenantContext(req).org.id, userId: sessionUser(req).id, entity: { kind: "inventory:part", id: row.id }, args: p.data, event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" } });
  const out = normaliseActionResult(result, "inventory.measure-material");
  if (!out.ok) return void res.status(409).json({ error: { code: "measurement_refused", message: typeof out.error === "string" ? out.error : "This measurement could not be recorded. Check the remaining amount and its usage tracker." } });
  res.json(out);
}));

export function registerMaterialActions() {
  platform().actions.registerHandler("inventory.measure-material", async (ctx) => {
    const args = (ctx.args ?? {}) as { partId?: string; gross_g?: number; used_mm?: number };
    const id = ctx.entity?.id ?? args.partId;
    if (!id) throw new ActionRefusal("Choose an item.");
    const p = Measure.safeParse(args);
    if (!p.success) throw new ActionRefusal(p.error.issues[0]?.message ?? "Give a measurement.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const view = await materialView(db, ctx.orgId, id);
    if (!view) throw new ActionRefusal("This item must be kept in a weight unit.");
    if (view.tracked_by) throw new ActionRefusal("Change this count in its external tracker.");
    const grams = p.data.gross_g != null ? weightFromScale(p.data.gross_g, view.empty_spool_g) : weightFromLength(p.data.used_mm!, view.density, view.diameter);
    const row = await db.selectFrom("inventory_parts").select("unit").where("id", "=", id).executeTakeFirstOrThrow();
    const qty = await platform().units.convert(ctx.orgId, grams, "g", row.unit);
    if (qty == null) throw new ActionRefusal("The weight cannot be converted to this item's unit.");
    return platform().actions.invoke(p.data.gross_g != null ? "inventory:set-stock" : "inventory:adjust-stock", {
      orgId: ctx.orgId, userId: ctx.userId, event: ctx.event, entity: { kind: "inventory:part", id },
      args: p.data.gross_g != null ? { partId: id, qty, reason: "Weighed on a scale" } : { partId: id, delta: -qty, reason: "Filament used by length" },
    });
  });
}

export const materialCostRouter = Router({ mergeParams: true });
materialCostRouter.get("/:kind/:id", asyncHandler(async (req, res) => {
  const orgId = tenantContext(req).org.id;
  const kind = String(req.params.kind);
  const id = String(req.params.id);
  const entity = await platform().entities.lookup(orgId, kind, id, { userId: sessionUser(req).id });
  if (!entity) return void res.status(404).json({ error: { code: "not_found", message: "No such record." } });
  const db = tenantDb(req);
  const ledger = await db.selectFrom("inventory_consumption").select(["part_id", sql<string>`sum(delta)`.as("delta")])
    .where("source_kind", "=", kind).where("source_id", "=", id).groupBy("part_id").execute();
  const viewCosts = await maySeeMaterialCosts(req);
  const items = [];
  for (const use of ledger) {
    const part = await db.selectFrom("inventory_parts").select(["id", "name", "unit", "instance"]).where("id", "=", use.part_id).executeTakeFirst();
    if (!part) continue;
    const grams = await platform().units.convert(orgId, -Number(use.delta), part.unit, "g");
    if (grams == null || grams <= 0) continue;
    const view = await materialView(db, orgId, part.id, viewCosts);
    const price = view?.price_per_kg;
    items.push({ id: part.id, name: part.name, instance: part.instance, grams, cost: price ? { amount: grams / 1000 * price.amount, currency: price.currency } : null });
  }
  res.json({ items });
}));
