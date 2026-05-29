// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-apps/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { appsRouter } from "./apps.js";

const router = Router({ mergeParams: true });

router.use("/apps", appsRouter);

export default router;
