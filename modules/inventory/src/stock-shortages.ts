import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "./db.js";
import { formatStockAmount } from "./stock-shapes.js";
import { stockViews } from "./api/stock-shapes.js";

export function registerShapedStockShortages() {
  platform().notifications.registerDigestContributor("inventory.low-stock", "inventory", async (orgId, raw) => {
    const db = raw as Kysely<InventoryDB>;
    const rows = await db.selectFrom("inventory_parts as p").innerJoin("inventory_stock as s", "s.part_id", "p.id").selectAll("p")
      .where("s.shape", "in", ["sheet", "wearing-tool"]).where("p.archived", "=", false).where("p.state", "=", "active").execute();
    const views = await stockViews(db, rows);
    const low = [...views.values()].filter(v => v.low && rows.find(r => r.id === v.id)?.metadata?.low_stock_alerts_excluded !== true);
    return Promise.all(low.map(async v => ({ key: `stock:${v.id}`, text: `${v.name}: ${formatStockAmount(v.remaining, v.unit)} left (minimum ${formatStockAmount(v.low_threshold, v.unit)})`, link: await platform().entities.recordAddressForEntity(orgId, v.kind, v.id) ?? "/inventory" })));
  });
}
