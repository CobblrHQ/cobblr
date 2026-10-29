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
import { asyncHandler } from "./util.js";
import { sessionUser, tenantContext } from "../db.js";
import { searchStock } from "../stock-search.js";
import { registerDeliveryCloseHeal } from "../close-delivered.js";
import { registerFollowSweep } from "../follow-parcels.js";
import { registerDueSweep } from "../due-reminders.js";

registerSalesResolvers();
registerSalesActionHandlers();
registerFollowSweep();
registerDueSweep();
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

// What a line can be sold from, across every collection that keeps stock.
// AI-REACH: exempt (the line picker's search; the assistant finds records with its own search across kinds and adds a line with sales:add-line)
router.get("/stock", asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const ctx = tenantContext(req);
  res.json({ items: await searchStock(ctx.org.id, q, { userId: sessionUser(req)?.id, role: ctx.role }) });
}));

export default router;

export { ordersRouter as primaryRouter };

// Side-effect: the assistant's door to adding a line to an existing order.
import { registerSalesLineHandlers } from "./line-handlers.js";
import { registerPrepareDocumentAction } from "./prepare-document-action.js";
import { registerSendDocumentAction } from "./send-document-action.js";
import { registerChangeLineAction } from "./change-line-action.js";
import { registerReturnLineAction } from "./return-line-action.js";
import { registerUndoReturnAction } from "./undo-return-action.js";
import { registerRecordPaymentAction } from "./record-payment-action.js";
import { registerUndoPaymentAction } from "./undo-payment-action.js";
import { registerHoldOrderAction } from "./hold-order-action.js";
import { registerReleaseHoldAction } from "./release-hold-action.js";
import { registerHoldSweep } from "../holds.js";
import { registerSalesDashboardReads } from "../dashboard-reads.js";

registerChangeLineAction();
registerReturnLineAction();
registerUndoReturnAction();
registerRecordPaymentAction();
registerUndoPaymentAction();
registerHoldOrderAction();
registerReleaseHoldAction();
registerHoldSweep();
registerSalesDashboardReads();

registerSendDocumentAction();

registerPrepareDocumentAction();
registerSalesLineHandlers();
