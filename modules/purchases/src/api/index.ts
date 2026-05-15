// Default-exported Router for the purchases module. Mounted at
// /api/v1/orgs/:slug/modules/purchases/ with requireAuth + withTenant.

import { Router } from "express";
import { ordersRouter } from "./orders.js";
import { registerPurchasesResolvers } from "./resolvers.js";

registerPurchasesResolvers();

const router = Router({ mergeParams: true });

router.use("/orders", ordersRouter);

export default router;
