import { Router } from "express";
import { z } from "zod";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { materialNumbers, weightFromLength } from "../material-numbers.js";
import { materialTotals } from "./material-ledger.js";
import { applyStockDelta } from "./action-handlers.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

export const nativeSpoolRouter = Router({ mergeParams: true });
const NativeUse = z.object({
  use_weight: z.number().finite().positive().optional(),
  use_length: z.number().finite().positive().optional(),
}).refine((v) => (v.use_weight != null) !== (v.use_length != null), "Give weight or length, not both.");
const positive = (v: unknown): number | null => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;

async function spools(req: Parameters<typeof tenantDb>[0], id?: number) {
  const db = tenantDb(req);
  const orgId = tenantContext(req).org.id;
  const collection = String(req.params.collection);
  let query = db.selectFrom("inventory_parts").selectAll().where("instance", "=", collection);
  if (id != null) query = query.where("asset_id", "=", id).limit(1);
  else {
    const offset = Number(req.query.offset ?? 0);
    const limit = req.query.limit == null ? null : Number(req.query.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || (limit != null && (!Number.isSafeInteger(limit) || limit < 1))) throw new ActionRefusal("Use a positive whole-number limit and a nonnegative whole-number offset.");
    if (req.query.allow_archived !== "true") query = query.where("archived", "=", false);
    query = query.offset(offset);
    if (limit != null) query = query.limit(limit);
  }
  const rows = await query.orderBy("asset_id").execute();
  const pairs = rows.length ? await platform().pairings.findBySources({ orgId, sourceKind: "inventory:part", sourceIds: rows.map((r) => r.id), targetKind: "inventory:part", relationshipKind: "instance-of" }) : [];
  const typeIds = [...new Set(pairs.map((p) => p.targetId))];
  const types = typeIds.length ? await db.selectFrom("inventory_parts").selectAll().where("id", "in", typeIds).execute() : [];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const parents = new Map(pairs.map((p) => [p.sourceId, typeById.get(p.targetId)]));
  const totals = await materialTotals(db, rows.map((r) => r.id));
  const paths = await platform().placement.pathsOf({ orgId, containees: rows.map((r) => ({ kind: "inventory:part", id: r.id })) });
  const factors = new Map<string, number | null>();
  for (const unit of new Set(rows.map((r) => r.unit))) factors.set(unit, await platform().units.convert(orgId, 1, unit, "g"));
  return rows.flatMap((r) => {
    const factor = factors.get(r.unit);
    if (factor == null) return [];
    const type = parents.get(r.id);
    const md = { ...(type?.metadata ?? {}), ...r.metadata };
    const density = positive(md.density);
    const diameter = positive(parseFloat(String(md.diameter)));
    const total = totals.get(r.id);
    const n = materialNumbers(Number(r.qty) * factor, positive(md.initial_g), density, diameter, [{ delta: Number(total?.net ?? 0) * factor, kind: null, at: "" }]);
    return [{
      id: r.asset_id, registered: new Date(r.created_at).toISOString(),
      first_used: total?.first_used, last_used: total?.last_used,
      remaining_weight: n.remaining_g, used_weight: n.used_g,
      remaining_length: n.remaining_m == null ? null : n.remaining_m * 1000,
      used_length: n.used_m == null ? null : n.used_m * 1000,
      filament: { id: type?.asset_id ?? r.asset_id, name: type?.name ?? r.name, material: md.material ?? null,
        density, diameter, weight: n.initial_g, spool_weight: positive(md.empty_spool_g),
        color_hex: typeof md.color === "string" ? md.color.replace(/^#/, "") : null,
        vendor: { name: type?.manufacturer ?? r.manufacturer ?? "" },
      },
      location: (paths.get(`inventory:part:${r.id}`) ?? []).map((p) => p.name).join(" / "),
      lot_nr: md.batch_code ?? null, comment: r.notes, archived: r.archived,
      extra: {}, cobblr: { id: r.id, tracked_by: md.tracked_by ?? null },
    }];
  });
}

for (const resource of ["filament", "vendor"] as const) {
  nativeSpoolRouter.get(`/api/v1/${resource}`, asyncHandler(async (req, res) => {
    const rows = await spools(req);
    const records = rows.map((s) => resource === "filament" ? s.filament : { id: s.filament.id, ...s.filament.vendor });
    res.json([...new Map(records.map((r) => [r.id, r])).values()]);
  }));
}
nativeSpoolRouter.get("/api/v1/info", (_req, res) => res.json({ version: "0.1.0", cobblr: true }));
nativeSpoolRouter.get("/api/v1/spool", asyncHandler(async (req, res) => {
  res.json(await spools(req));
}));
nativeSpoolRouter.param("id", (_req, res, next, raw: string) => {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) return void res.status(400).json({ message: "Use a positive numeric spool id." });
  next();
});
nativeSpoolRouter.get("/api/v1/spool/:id", asyncHandler(async (req, res) => {
  const row = (await spools(req, Number(req.params.id)))[0];
  if (!row) return void res.status(404).json({ message: "Spool not found." });
  res.json(row);
}));
// AI-REACH: exempt a firmware report; a manager reports actual use, a person never impersonates one
// UI-REACH: exempt a firmware report; configured in the manager through the LAN bridge
nativeSpoolRouter.put("/api/v1/spool/:id/use", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:measure-material"))) return;
  const p = NativeUse.safeParse(req.body);
  if (!p.success) return void badBody(res, p.error);
  const spool = (await spools(req, Number(req.params.id)))[0];
  if (!spool) return void res.status(404).json({ message: "Spool not found." });
  if (spool.archived) return void res.status(409).json({ message: "Unarchive this spool before reporting use." });
  if (spool.cobblr.tracked_by !== "firmware") return void res.status(409).json({ message: "Choose Firmware reports as this spool's usage tracker first." });
  const grams = p.data.use_weight ?? weightFromLength(p.data.use_length!, spool.filament.density, spool.filament.diameter);
  const orgId = tenantContext(req).org.id;
  const row = await tenantDb(req).selectFrom("inventory_parts").select("unit").where("id", "=", spool.cobblr.id).executeTakeFirstOrThrow();
  const delta = await platform().units.convert(orgId, -grams, "g", row.unit);
  if (delta == null) throw new Error("This spool is not kept in a weight unit.");
  const result = await applyStockDelta(orgId, { partId: spool.cobblr.id, delta, reporter: "firmware", reason: "Print manager reported filament use", sourceKind: "inventory:firmware" });
  if (result.skipped) return void res.status(409).json({ message: "This spool's count is kept by another tracker." });
  if (result.ok !== true) return void res.status(409).json({ message: String(result.error) });
  res.json((await spools(req, Number(req.params.id)))[0]);
}));
