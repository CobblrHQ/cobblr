// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-units/
// with requireAuth + withTenant pre-applied by the platform.

import { Router } from "express";
import { unitsRouter } from "./units.js";

const router = Router({ mergeParams: true });

router.use("/units", unitsRouter);

export default router;
