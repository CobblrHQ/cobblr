// core-fitness router. Mounted at /api/v1/orgs/:slug/modules/core-fitness/.
// Registers entity resolvers at load time.

import { Router } from "express";
import { metricsRouter } from "./metrics.js";
import { registerFitnessResolvers } from "./resolvers.js";
import { registerFitnessActionHandlers } from "./action-handlers.js";

registerFitnessResolvers();
registerFitnessActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", metricsRouter);

export default router;
