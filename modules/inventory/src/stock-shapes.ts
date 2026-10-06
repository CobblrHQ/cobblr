import { quantityWithUnit } from "@cobblr/platform-contract/plural";
import { z } from "zod";
import type { SheetArea, SheetSpec } from "./sheet-area.js";
const threshold = { low_threshold: z.number().finite().nonnegative().max(999999999).default(0) };
export const StockConfig = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("sheet"), ...threshold }),
  z.object({ shape: z.literal("roll"), unit: z.literal("m").default("m"), width_mm: z.number().finite().positive().max(100000), waste: z.number().finite().nonnegative().max(100000).default(0), ...threshold }),
  z.object({ shape: z.literal("spool"), unit: z.enum(["g", "m"]), grams_per_m: z.number().finite().positive().max(100000).optional(), ...threshold }),
  z.object({ shape: z.literal("liquid"), unit: z.literal("ml").default("ml"), ...threshold }),
  z.object({ shape: z.literal("wearing-tool"), unit: z.enum(["h", "uses", "m"]), limit: z.number().finite().positive().max(10_000_000), ...threshold }),
  z.object({ shape: z.literal("count"), unit: z.literal("each").default("each"), ...threshold }),
]);
export type StockConfig = z.infer<typeof StockConfig>;
export type StockShape = StockConfig["shape"];
export type StockSheet = SheetArea & { spec: SheetSpec };
export function formatStockAmount(value: number, unit: string): string {
  const measured = ["m", "g", "ml", "h", "mm²", "kg", "mm", "cm", "l", "min"].includes(unit);
  return quantityWithUnit(value, unit, measured ? { symbol: unit, name: unit, plural: unit, category: "measure" } : null, [{ singular: "use", plural: "uses" }, { singular: "each", plural: "each" }], 9);
}
const round = (n: number) => Math.round(n * 1e9) / 1e9;
export function stockReading(config: StockConfig, qty: number, used: number, sheet?: StockSheet) {
  const remaining = config.shape === "sheet" ? sheet && qty > 0 ? round(sheet.percent_left * sheet.spec.width_mm * sheet.spec.height_mm / 100) : 0
    : config.shape === "wearing-tool" ? qty > 0 ? Math.max(0, round(config.limit - used)) : 0 : Math.max(0, qty);
  return { shape: config.shape, unit: config.shape === "sheet" ? "mm²" : config.unit, remaining, used,
    low_threshold: config.low_threshold, low: remaining <= config.low_threshold,
    maintenance_due: config.shape === "wearing-tool" && used >= config.limit, sheet };
}

export function consumeAmount(config: StockConfig, qty: number, used: number, input: { amount: number; unit: string; waste?: number }) {
  if (config.shape === "sheet") throw new Error("Record a sheet's used rectangles.");
  if (config.shape === "wearing-tool" && qty <= 0) throw new Error("This tool is no longer on hand.");
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Give a positive amount used.");
  const units: Record<string, { unit: string; factor: number }> = {
    mm: { unit: "m", factor: 0.001 }, cm: { unit: "m", factor: 0.01 }, m: { unit: "m", factor: 1 },
    kg: { unit: "g", factor: 1000 }, g: { unit: "g", factor: 1 }, l: { unit: "ml", factor: 1000 }, ml: { unit: "ml", factor: 1 },
    min: { unit: "h", factor: 1 / 60 }, h: { unit: "h", factor: 1 }, uses: { unit: "uses", factor: 1 }, each: { unit: "each", factor: 1 },
  };
  const from = units[input.unit];
  if (!from) throw new Error("Choose a supported stock unit.");
  let amount = input.amount * from.factor;
  if (from.unit !== config.unit) {
    if (config.shape !== "spool" || !["g", "m"].includes(from.unit)) throw new Error(`This stock is measured in ${config.unit}.`);
    if (!config.grams_per_m) throw new Error("Save grams per metre before converting this spool's weight and length.");
    amount = config.unit === "g" ? amount * config.grams_per_m : amount / config.grams_per_m;
  }
  const waste = input.waste ?? (config.shape === "roll" ? config.waste : 0);
  if (!Number.isFinite(waste) || waste < 0) throw new Error("Waste must be zero or more, in the stock's unit.");
  amount = round(amount + waste);
  if (amount <= 0) throw new Error("This amount is too small to record in the stock unit.");
  if (config.shape === "count" && !Number.isInteger(amount) || config.shape === "wearing-tool" && config.unit === "uses" && !Number.isInteger(amount)) throw new Error("Use whole units for a count.");
  if (config.shape !== "wearing-tool" && amount > qty) throw new Error(`Only ${formatStockAmount(qty, config.unit)} remains. Record a recount before using more.`);
  if (config.shape === "wearing-tool") return { amount, ...stockReading(config, qty, round(used + amount)) };
  return { amount, ...stockReading(config, round(qty - amount), used) };
}
