import { Router } from "express";
import { z } from "zod";
import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import { tenantContext, sessionUser, type InventoryDB } from "../db.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

interface CatalogFilament {
  id: string; manufacturer: string; name: string; material: string;
  density?: number; diameter?: number; spool_weight?: number; weight?: number;
  color_hex?: string; color_hexes?: string[]; extruder_temp?: number; bed_temp?: number;
}
const CATALOG = "https://donkie.github.io/SpoolmanDB/filaments.json";
let cached: { at: number; rows: CatalogFilament[] } | null = null;
let reading: Promise<CatalogFilament[]> | null = null;
async function catalog(orgId: string): Promise<CatalogFilament[]> {
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.rows;
  if (reading) return reading;
  reading = (async () => {
    const res = await platform().egress.guardedFetch(orgId, CATALOG, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Filament catalog responded ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("The filament catalog is not a list.");
    const rows = data.filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && typeof r.manufacturer === "string" && typeof r.material === "string") as CatalogFilament[];
    cached = { at: Date.now(), rows };
    return rows;
  })();
  try { return await reading; } finally { reading = null; }
}
export const filamentCatalogRouter = Router({ mergeParams: true });
filamentCatalogRouter.get("/", asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  if (q.length < 2) return void res.json({ items: [], total: 0 });
  const matches = (await catalog(tenantContext(req).org.id)).filter((r) => `${r.manufacturer} ${r.name} ${r.material}`.toLowerCase().includes(q));
  res.json({ items: matches.slice(0, 30), total: matches.length });
}));
const Import = z.object({ catalog_id: z.string().min(1).max(200) });
// AI-REACH: action inventory:create-item
filamentCatalogRouter.post("/", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "inventory:create-item"))) return;
  const p = Import.safeParse(req.body);
  if (!p.success) return void badBody(res, p.error);
  res.json(await importFilamentType({
    orgId: tenantContext(req).org.id, userId: sessionUser(req).id, args: p.data,
    event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
  }));
}));

export async function importFilamentType(ctx: ActionInvokeContext) {
    const p = Import.safeParse(ctx.args);
    if (!p.success) throw new Error("Choose a filament from the catalog.");
    const r = (await catalog(ctx.orgId)).find((row) => row.id === p.data.catalog_id);
    if (!r) throw new Error("That filament is no longer in the catalog.");
    const configs = await platform().instances.list(ctx.orgId);
    if (!configs.some((i) => i.instance_name === "filament-types") || !configs.some((i) => i.instance_name === "filament-vendors")) throw new Error("Install or update the Filament bundle before importing a type.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const old = await db.selectFrom("inventory_parts").select("id").where("instance", "=", "filament-types").where(sql`metadata->>'spoolmandb_id'`, "=", r.id).executeTakeFirst();
    if (old) return { ok: true, id: old.id, existing: true };
    let vendor = await db.selectFrom("inventory_parts").select("id").where("instance", "=", "filament-vendors").where("name", "=", r.manufacturer).executeTakeFirst();
    if (!vendor) {
      const out = await platform().actions.invoke("inventory:create-item", { ...ctx, args: { instance: "filament-vendors", qty: 0, name: r.manufacturer, fields: {} } });
      const result = out as { ok?: boolean; item_id?: string };
      if (result.ok !== true || typeof result.item_id !== "string") throw new Error("Could not create the filament vendor.");
      vendor = { id: result.item_id };
    }
    const colour = r.color_hexes?.length ? `multi(${r.color_hexes.map((c) => `#${c}`).join(",")})` : r.color_hex ? `#${r.color_hex}` : null;
    const out = await platform().actions.invoke("inventory:create-item", { ...ctx, args: {
      instance: "filament-types", qty: 0, name: `${r.manufacturer} ${r.name} ${r.material}`, manufacturer: r.manufacturer,
      fields: { spoolmandb_id: r.id, vendor_id: vendor.id, material: r.material, density: r.density ?? null,
        diameter: r.diameter ? `${r.diameter} mm` : null, empty_spool_g: r.spool_weight ?? null,
        color: colour, nozzle_temp: r.extruder_temp ?? null, bed_temp: r.bed_temp ?? null },
    } });
    const result = out as { ok?: boolean; item_id?: string };
    if (result.ok !== true || !result.item_id) throw new Error("Could not import the filament type.");
    return { ...result, id: result.item_id };
}
