// Default-exported Router for the purchases module. Mounted at
// /api/v1/orgs/:slug/modules/purchases/ with requireAuth + withTenant.

import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ordersRouter } from "./orders.js";
import { vendorsRouter } from "./vendors.js";
import { registerPurchasesResolvers } from "./resolvers.js";
import { registerPurchasesActionHandlers } from "./action-handlers.js";
import { registerPurchasesCalendarSource } from "./calendar-source.js";

registerPurchasesResolvers();
registerPurchasesActionHandlers();
registerPurchasesCalendarSource();

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones (orders are the primary entity).
platform().instances.registerItemCounter("purchases", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from purchases_orders where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });

router.use("/orders", ordersRouter);
router.use("/vendors", vendorsRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD (orders are the
// primary entity; order_items stay scoped via their parent order).
export { ordersRouter as primaryRouter };
