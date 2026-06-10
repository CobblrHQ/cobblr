// digifab router. Mounted at
//   /api/v1/orgs/:slug/modules/digifab/.

import { Router } from "express";
import { connectionsRouter } from "./connections.js";
import { jobsRouter } from "./jobs.js";
import { linksRouter } from "./links.js";
import { driversRouter } from "./drivers.js";
import { registerFarmResolvers } from "./resolvers.js";
import { registerActionHandlers } from "./action-handlers.js";

registerFarmResolvers();
registerActionHandlers(); // the digifab:run-command actuator action surface

const router = Router({ mergeParams: true });
router.use("/connections", connectionsRouter);
router.use("/jobs", jobsRouter);
router.use("/links", linksRouter);
router.use("/drivers", driversRouter);

export default router;
