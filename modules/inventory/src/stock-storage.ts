import { z } from "zod";

export const MslSchema = z.enum(["1", "2", "2a", "3", "4", "5", "5a", "6"]);
export type Msl = z.infer<typeof MslSchema>;
const FLOOR_HOURS: Record<Exclude<Msl, "1" | "6">, number> = { "2": 365 * 24, "2a": 28 * 24, "3": 168, "4": 72, "5": 48, "5a": 24 };

export const StorageSchema = z.object({
  mode: z.enum(["sealed", "dry", "open", "baking"]),
  exposed_ms: z.number().finite().nonnegative(),
  changed_at: z.string().datetime(),
  baked_at: z.string().datetime().nullable(),
  bake: z.object({ started_at: z.string().datetime(), minutes: z.number().finite().positive(), temperature_c: z.number().finite().positive(), instruction: z.string().trim().min(1).max(500) }).nullable(),
});
export type StockStorage = z.infer<typeof StorageSchema>;
export type StorageChange = { operation: "open" | "dry" | "complete-bake" } | { operation: "start-bake"; minutes: number; temperature_c: number; instruction: string };

export function initialStorage(now: Date): StockStorage {
  return { mode: "sealed", exposed_ms: 0, changed_at: now.toISOString(), baked_at: null, bake: null };
}

export function storageReadiness(storage: StockStorage, msl: Msl | null, now: Date, level6Hours: number | null = null) {
  const state = StorageSchema.parse(storage);
  const changed = new Date(state.changed_at).getTime();
  if (!Number.isFinite(now.getTime()) || changed > now.getTime()) throw new Error("The storage clock is ahead of the server clock. Check the record before use.");
  const exposedMs = msl === "6" && state.baked_at ? now.getTime() - new Date(state.baked_at).getTime() : state.exposed_ms + (state.mode === "open" ? now.getTime() - changed : 0);
  const limitHours = msl === null || msl === "1" ? null : msl === "6" ? level6Hours : FLOOR_HOURS[msl];
  const remainingHours = limitHours === null ? null : Math.max(0, limitHours - exposedMs / 3_600_000);
  const reason = state.mode === "baking" ? "This stock is being baked. Complete the bake before use."
    : msl === null ? "Confirm this part's moisture sensitivity before use."
    : msl === "6" && (!state.baked_at || !level6Hours || !Number.isFinite(level6Hours) || level6Hours <= 0) ? "Bake before use and enter the floor life printed on the label."
    : remainingHours !== null && remainingHours <= 0 ? "This stock has exceeded its moisture floor life. Bake it before use."
    : null;
  return { exposed_ms: exposedMs, remaining_hours: remainingHours, usable: reason === null, reason };
}

export function changeStorage(storage: StockStorage, change: StorageChange, now: Date): StockStorage {
  const state = StorageSchema.parse(storage);
  const changed = new Date(state.changed_at).getTime();
  if (!Number.isFinite(now.getTime()) || changed > now.getTime()) throw new Error("The storage clock is ahead of the server clock.");
  const exposedMs = state.exposed_ms + (state.mode === "open" ? now.getTime() - changed : 0);
  if (change.operation === "start-bake") {
    if (state.mode === "baking") throw new Error("A bake is already running.");
    const bake = StorageSchema.shape.bake.unwrap().parse({ started_at: now.toISOString(), minutes: change.minutes, temperature_c: change.temperature_c, instruction: change.instruction });
    return { ...state, mode: "baking", exposed_ms: exposedMs, changed_at: now.toISOString(), bake };
  }
  if (change.operation === "complete-bake") {
    if (state.mode !== "baking" || !state.bake) throw new Error("Start the bake timer first.");
    if (now.getTime() < new Date(state.bake.started_at).getTime() + state.bake.minutes * 60_000) throw new Error("The bake timer has not finished.");
    return { mode: "dry", exposed_ms: 0, changed_at: now.toISOString(), baked_at: now.toISOString(), bake: null };
  }
  if (state.mode === "baking") throw new Error("Complete the bake before changing storage.");
  const mode = change.operation === "open" ? "open" : "dry";
  if (state.mode === mode) return state;
  return { ...state, mode, exposed_ms: exposedMs, changed_at: now.toISOString() };
}

export { placementConsumption } from "@cobblr/platform-contract/placement-count";
