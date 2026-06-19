// core-scan router. Mounted at
//   /api/v1/orgs/:slug/modules/core-scan/.

import { Router } from "express";
import { inboxRouter } from "./inbox.js";
import { entityImageRouter } from "./entity-image.js";
import { registerScanHandlers } from "./handlers.js";

registerScanHandlers();

const router = Router({ mergeParams: true });
router.use("/", inboxRouter);
router.use("/", entityImageRouter);

export default router;
