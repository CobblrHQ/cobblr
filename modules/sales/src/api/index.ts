// sales router. Mounted at /api/v1/orgs/:slug/modules/sales/.
// Registers resolvers + action handlers at load. Orders are the primary entity.

import { intakeRouter } from "./intake.js";
import { registerIntakeSweep } from "../intake.js";
import { registerIntakeServices } from "../intake-services.js";
import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ordersRouter } from "./orders.js";
import { customersRouter } from "./customers.js";
import { registerSalesResolvers } from "./resolvers.js";
import { registerSalesActionHandlers } from "./action-handlers.js";
import { followParcelsRouter } from "./follow-parcels.js";
import { registerDeliveryCloseHeal } from "../close-delivered.js";
import { registerFollowSweep } from "../follow-parcels.js";

registerSalesResolvers();
registerSalesActionHandlers();
registerFollowSweep();
registerIntakeServices();
registerIntakeSweep();
registerDeliveryCloseHeal();

// Per-instance item count (orders are the primary entity) — lets the nav hide
// an empty auto-created default instance once named ones exist.
platform().instances.registerItemCounter("sales", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from sales_orders where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });
router.use("/intake", intakeRouter);
router.use("/orders", ordersRouter);
router.use("/customers", customersRouter);
router.use("/follow-parcels", followParcelsRouter);

export default router;

export { ordersRouter as primaryRouter };

// Side-effect: the assistant's door to adding a line to an existing order.
import { registerSalesLineHandlers } from "./line-handlers.js";
registerSalesLineHandlers();
