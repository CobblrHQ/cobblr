// DONE WHEN: no sheet-shaped inventory_parts row lacks its inventory_stock row.
// BORN WITH: inventory_stock_sheet_birth in migrations/0019_stock_shapes.sql.
import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { InventoryDB } from "./db.js";

export async function healStockShapesIn(db: Kysely<InventoryDB>): Promise<number> {
  const rows = await sql<{ part_id: string }>`insert into inventory_stock (part_id, config)
    select p.id, '{"shape":"sheet","low_threshold":0}'::jsonb from inventory_parts p
    where (jsonb_typeof(p.metadata->'laser_sheet') = 'object'
      or p.metadata ?& ARRAY['material','width_mm','height_mm','thickness_mm'])
      and not exists (select 1 from inventory_stock s where s.part_id = p.id)
    on conflict (part_id) do nothing returning part_id`.execute(db);
  return rows.rows.length;
}
export function registerStockShapesHeal() {
  registerHealPass({ name: "inventory.heal-stock-shapes", shim: "modules/inventory/src/heal-stock-shapes.ts", module: "inventory", visit: ({ db }) => healStockShapesIn(db as Kysely<InventoryDB>) });
}
