import { ActionRefusal, platform, type ActionInvokeContext, type ResolvedEntity } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { CncStationStock } from "@cobblr/platform-contract/cnc";
import { z } from "zod";
import { ReviewRequired } from "./drivers/job-review.js";
import type { CncStockUse } from "./cnc-runtime.js";

async function invokeStock(action: string, ctx: ActionInvokeContext) {
  try { return await platform().actions.invoke(action, ctx); }
  catch (e) { if (e instanceof ActionRefusal) throw new ReviewRequired(e.message); throw e; }
}

const positive = z.number().finite().positive();
const NativeStock = z.object({
  shape: z.enum(["sheet", "count", "wearing-tool"]),
  revision: z.number().int().nonnegative(), remaining: z.number().finite().nonnegative(), unit: z.string(),
  sheet: z.object({
    spec: z.object({ width_mm: positive, height_mm: positive, thickness_mm: positive }),
    free_rectangles: z.array(z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: positive, height: positive })),
  }).optional(),
});

export function cncStockFromEntity(entity: ResolvedEntity | null): CncStationStock | null {
  if (!entity || entity.retired || entity.fields.state !== "active" || !Number.isFinite(Number(entity.fields.qty)) || Number(entity.fields.qty) <= 0) return null;
  const parsed = NativeStock.safeParse(entity.fields.stock);
  if (!parsed.success || parsed.data.remaining <= 0) return null;
  const stock = parsed.data;
  if (stock.shape === "count" && stock.remaining < 1) return null;
  if (stock.shape === "wearing-tool" && stock.unit !== "h") return null;
  const metadata = z.record(z.unknown()).safeParse(entity.fields.metadata);
  const measure = (key: string) => {
    const result = positive.safeParse(metadata.success ? metadata.data[key] : undefined);
    return result.success ? result.data : undefined;
  };
  return {
    id: entity.id, name: entity.title, shape: stock.shape === "wearing-tool" ? "wearing_tool" : stock.shape,
    revision: stock.revision, remaining: stock.remaining,
    width: stock.shape === "sheet" ? stock.sheet?.spec.width_mm : measure("width_mm"),
    height: stock.shape === "sheet" ? stock.sheet?.spec.height_mm : measure("height_mm"),
    thickness: stock.shape === "sheet" ? stock.sheet?.spec.thickness_mm : measure("thickness_mm"),
    diameter: measure("diameter_mm"), freeRectangles: stock.sheet?.free_rectangles,
  };
}

export async function cncStationStock(orgId: string, q?: string): Promise<CncStationStock[]> {
  const stockKind = "inventory:part";
  const inventories = (await platform().instances.list(orgId)).filter(instance => instance.module_name === stockKind.split(":")[0]);
  const kinds = [...new Set(["inventory:part", ...inventories.map(instance => instance.is_default ? "inventory:part" : `${instance.instance_name}:item`)])];
  const stocks = await Promise.all(kinds.map(async kind => {
    const result: CncStationStock[] = [];
    for (let offset = 0;; offset += 200) {
      const page = await platform().entities.list(orgId, kind, { q, limit: 200, offset });
      for (const entity of page.items) {
        const stock = cncStockFromEntity(entity);
        if (stock) result.push(stock);
      }
      if (!page.items.length || page.items.length < 200 || page.total !== undefined && offset + page.items.length >= page.total) return result;
    }
  }));
  return [...new Map(stocks.flat().map(stock => [stock.id, stock])).values()];
}

export async function requireCncStock(orgId: string, id: string): Promise<CncStationStock> {
  const stock = cncStockFromEntity(await platform().entities.lookup(orgId, "inventory:part", id));
  if (!stock) throw new ReviewRequired("Choose available CNC stock or a wearing tool measured in hours.");
  return stock;
}

export async function requireCncLoadedStock(orgId: string, stationId: string, ids: readonly string[]): Promise<void> {
  const result = normaliseActionResult(await invokeStock("inventory:list-stock", {
    orgId, userId: null, args: { fields: { station: stationId, limit: 1 } },
    event: { name: null, payload: {}, actor: { user_id: null, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
  }), "inventory.list-stock");
  const loaded = z.array(z.object({ part_id: z.string() })).safeParse(result.ok ? result.data?.loaded : undefined);
  if (!loaded.success || ids.some(id => !loaded.data.some(item => item.part_id === id))) throw new ReviewRequired("Confirm this blank and every bit as loaded at this station before Start.");
}

export async function consumeCncStock(orgId: string, userId: string | null, uses: readonly CncStockUse[]): Promise<void> {
  for (const use of uses) {
    const entity = await platform().entities.lookup(orgId, "inventory:part", use.partId);
    const parsed = NativeStock.safeParse(entity?.fields.stock);
    if (!entity || !parsed.success) throw new ReviewRequired("The CNC stock record is unavailable. Keep the piece aside until its use is recorded.");
    const stock = parsed.data;
    if (stock.shape !== (use.shape === "wearing_tool" ? "wearing-tool" : use.shape) || use.shape === "wearing_tool" && stock.unit !== "h") throw new ReviewRequired("The CNC stock shape or tool unit changed. Restore its reviewed configuration before recording use.");
    const result = normaliseActionResult(await invokeStock("inventory:consume-stock", {
      orgId, userId, entity: { kind: entity.kind, id: use.partId },
      args: { fields: { source: use.source, verdict: use.outcome === "good" ? "good" : "scrap",
        ...(use.shape === "sheet" ? { rectangles: [use.region], kerf_mm: 0, spacing_mm: 0 } : { amount: use.amount, unit: use.shape === "wearing_tool" ? "h" : "each" }) } },
      event: { name: "digifab.machine.outcome", payload: { source: use.source }, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" },
    }), "inventory.consume-stock");
    if (!result.ok) throw new ReviewRequired(result.error);
  }
}
