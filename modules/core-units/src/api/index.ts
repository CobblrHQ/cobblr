// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-units/
// with requireAuth + withTenant pre-applied by the platform.

import { Router } from "express";
import { unitsRouter } from "./units.js";
import { registerUnitsService } from "./platform-service.js";

// The vocabulary owner registers the platform().units service at load —
// server-side resolve/convert for every consumer, through the contract only.
registerUnitsService();

const router = Router({ mergeParams: true });

router.use("/units", unitsRouter);

export default router;
