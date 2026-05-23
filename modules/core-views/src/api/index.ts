// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-views/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { viewsRouter } from "./views.js";

const router = Router({ mergeParams: true });

router.use("/views", viewsRouter);

export default router;
