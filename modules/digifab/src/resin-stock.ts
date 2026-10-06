import { createHash } from "node:crypto";
import { z } from "zod";
import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { PlateMetadata } from "./library/extract-metadata.js";
export interface ResinStock { id: string; kind: string; name: string; shape: string; unit: string; remaining: number; used: number; revision: number; slot: string; maintenance_due?: boolean; low?: boolean }
export interface ResinAllocation { id: string; kind: string; amount: number; unit: string; purpose: "resin" | "film" | "lcd" }
const round = (value: number) => Math.round(value * 1e9) / 1e9;
export function planResinPrint(metadata: PlateMetadata, loaded: ResinStock[], reserved: Record<string, number> = {}) {
  const allocations: ResinAllocation[] = [];
  const refuse = (warning: string) => ({ canStart: false, warning, allocations });
  if (!Number.isFinite(metadata.resin_ml) || !(metadata.resin_ml! > 0) || !Number.isInteger(metadata.layers) || !(metadata.layers! > 0)) return refuse("This sliced file needs a valid resin volume and layer count before Start.");
  const bottle = loaded.find(stock => stock.slot === "bottle"), vat = loaded.find(stock => stock.slot === "vat");
  if (!bottle || [bottle, ...(vat ? [vat] : [])].some(stock => stock.shape !== "liquid" || stock.unit !== "ml" || !Number.isFinite(stock.remaining) || stock.remaining < 0)) return refuse("Load a liquid resin bottle, measured in ml, before Start.");
  if (vat?.id === bottle.id) return refuse("The vat and bottle need separate stock records so their resin is counted once.");
  const liquids = [...(vat ? [vat] : []), bottle];
  const available = (stock: ResinStock) => Math.max(0, round(stock.remaining - (reserved[stock.id] ?? 0)));
  const total = round(liquids.reduce((sum, stock) => sum + available(stock), 0));
  if (total < metadata.resin_ml!) return refuse(`This print needs ${metadata.resin_ml} ml; the vat and bottle have ${total} ml.`);
  let needed = metadata.resin_ml!;
  for (const stock of liquids) {
    const amount = Math.min(available(stock), needed);
    if (amount > 0) allocations.push({ id: stock.id, kind: stock.kind, amount, unit: "ml", purpose: "resin" });
    needed = round(needed - amount);
  }
  const films = loaded.filter(stock => stock.slot === "film-layers" || stock.slot === "film-prints");
  if (films.length > 1) return refuse("Load one film record and choose whether it counts layers or prints.");
  if (films[0]) {
    const film = films[0];
    if (film.shape !== "wearing-tool" || film.unit !== "uses") return refuse("The film needs a wearing tool stock record measured in uses.");
    allocations.push({ id: film.id, kind: film.kind, amount: film.slot === "film-layers" ? metadata.layers! : 1, unit: "uses", purpose: "film" });
  }
  const lcd = loaded.find(stock => stock.slot === "lcd");
  if (lcd) {
    if (lcd.shape !== "wearing-tool" || lcd.unit !== "h") return refuse("The LCD needs a wearing tool stock record measured in hours.");
    const seconds = metadata.exposure_sec ?? metadata.estimated_sec;
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return refuse("This file has no exposure or print time estimate for the loaded LCD.");
    allocations.push({ id: lcd.id, kind: lcd.kind, amount: round(seconds / 3600), unit: "h", purpose: "lcd" });
  }
  return { canStart: true, warning: "", allocations };
}
export function resinStationKey(connectionId: string, deviceId: string): string {
  return `resin:${connectionId}:${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}`;
}
const StockReading = z.object({ shape: z.string(), unit: z.string(), remaining: z.number().finite().nonnegative(), used: z.number().finite().nonnegative(), revision: z.number().int().nonnegative(), maintenance_due: z.boolean().optional(), low: z.boolean().optional() });
export function resinActionContext(orgId: string, userId: string | null, args: Record<string, unknown>, entity?: { kind: string; id: string }): ActionInvokeContext {
  return { orgId, userId, args, entity, event: { name: "digifab.resin.stock", payload: {}, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" } };
}
export async function readResinItem(orgId: string, kind: string, id: string, slot = ""): Promise<ResinStock> {
  const entity = await platform().entities.lookup(orgId, kind, id);
  const reading = StockReading.safeParse(entity?.fields.stock);
  if (!entity || entity.retired || !reading.success) throw new Error("The loaded stock is unavailable. Check its Inventory record.");
  return { id, kind: entity.kind, name: entity.title, ...reading.data, slot };
}
export async function readLoadedResinStock(orgId: string, connectionId: string, deviceId: string): Promise<ResinStock[]> {
  const station = resinStationKey(connectionId, deviceId);
  const result = normaliseActionResult(await platform().actions.invoke("inventory:list-stock", resinActionContext(orgId, null, { fields: { station, limit: 1 } })), "inventory.list-stock");
  if (!result.ok) throw new Error("Enable Inventory and configure its liquid stock before using this resin station.");
  const data = z.object({ loaded: z.array(z.object({ part_id: z.string(), slot: z.string() })) }).parse(result.data);
  return Promise.all(data.loaded.filter(item => ["bottle", "vat", "film-layers", "film-prints", "lcd"].includes(item.slot)).map(item => readResinItem(orgId, "inventory:part", item.part_id, item.slot)));
}
