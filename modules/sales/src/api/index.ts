// sales router. Mounted at /api/v1/orgs/:slug/modules/sales/.
// Registers resolvers + action handlers at load. Orders are the primary entity.

import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ordersRouter } from "./orders.js";
import { customersRouter } from "./customers.js";
import { registerSalesResolvers } from "./resolvers.js";
import { registerSalesActionHandlers } from "./action-handlers.js";

registerSalesResolvers();
registerSalesActionHandlers();

// Per-instance item count (orders are the primary entity) — lets the nav hide
// an empty auto-created default instance once named ones exist.
platform().instances.registerItemCounter("sales", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from sales_orders where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });
router.use("/orders", ordersRouter);
router.use("/customers", customersRouter);

export default router;

export { ordersRouter as primaryRouter };
