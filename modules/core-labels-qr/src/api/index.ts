// core-labels-qr router. Mounted at /api/v1/orgs/:slug/modules/core-labels-qr/.

import { Router } from "express";
import { tokensRouter } from "./tokens.js";

const router = Router({ mergeParams: true });
router.use("/tokens", tokensRouter);

export default router;
