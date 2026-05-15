// Default-exported Router. Mounted by the platform at
// /api/v1/orgs/:slug/modules/labels/ with requireAuth +
// withTenant pre-applied.
//
// Side effect on import: registers the labels:print action handler
// with the platform.

import { Router } from "express";
import { queueRouter } from "./queue.js";
import { printRouter } from "./print.js";
import { registerLabelsHandlers } from "./handlers.js";

registerLabelsHandlers();

const router = Router({ mergeParams: true });

router.use("/queue", queueRouter);
router.use("/print", printRouter);

export default router;
