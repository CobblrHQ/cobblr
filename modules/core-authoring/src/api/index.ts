// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-authoring/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { draftsRouter } from "./drafts.js";

const router = Router({ mergeParams: true });

router.use("/", draftsRouter);

export default router;
