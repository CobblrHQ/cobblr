// core-farm router. Mounted at
//   /api/v1/orgs/:slug/modules/core-farm/.

import { Router } from "express";
import { connectionsRouter } from "./connections.js";
import { jobsRouter } from "./jobs.js";

const router = Router({ mergeParams: true });
router.use("/connections", connectionsRouter);
router.use("/jobs", jobsRouter);

export default router;
