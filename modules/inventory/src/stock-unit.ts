import type { Kysely } from "kysely";
import type { InventoryDB } from "./db.js";

export async function stockUnitRefusal(db: Kysely<InventoryDB>, id: string, unit: string): Promise<string | null> {
  const row = await db.selectFrom("inventory_stock").select("config").where("part_id", "=", id).executeTakeFirst();
  const config = row?.config;
  return config && (config.shape === "roll" || config.shape === "spool" || config.shape === "liquid") && config.unit !== unit
    ? "Keep this stock's measured unit. Use Set stock shape to recount it in a different unit." : null;
}
