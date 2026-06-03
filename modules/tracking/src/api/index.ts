// tracking router. Mounted at /api/v1/orgs/:slug/modules/tracking/.
// Registers entity resolvers at load time.

import { Router } from "express";
import { metricsRouter } from "./metrics.js";
import { registerTrackingResolvers } from "./resolvers.js";
import { registerTrackingActionHandlers } from "./action-handlers.js";

registerTrackingResolvers();
registerTrackingActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", metricsRouter);

export default router;
