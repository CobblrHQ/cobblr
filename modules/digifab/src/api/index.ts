// digifab router. Mounted at
//   /api/v1/orgs/:slug/modules/digifab/.

import { Router } from "express";
import { connectionsRouter } from "./connections.js";
import { jobsRouter } from "./jobs.js";
import { linksRouter } from "./links.js";
import { driversRouter } from "./drivers.js";
import { registerFarmResolvers } from "./resolvers.js";
import { registerDeviceSeam } from "./device-provider.js";

registerFarmResolvers();
registerDeviceSeam(); // back platform().devices.getDriver + the digifab:run-command alias

const router = Router({ mergeParams: true });
router.use("/connections", connectionsRouter);
router.use("/jobs", jobsRouter);
router.use("/links", linksRouter);
router.use("/drivers", driversRouter);

export default router;
