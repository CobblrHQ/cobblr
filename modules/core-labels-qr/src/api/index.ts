// core-labels-qr router. Mounted at /api/v1/orgs/:slug/modules/core-labels-qr/.

import { Router } from "express";
import { tokensRouter } from "./tokens.js";
import { settingsRouter } from "./settings.js";

const router = Router({ mergeParams: true });
router.use("/tokens", tokensRouter);
router.use("/settings", settingsRouter);

export default router;
