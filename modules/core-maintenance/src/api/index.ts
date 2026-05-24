// core-maintenance router. Mounted at
//   /api/v1/orgs/:slug/modules/core-maintenance/.

import { Router } from "express";
import { entriesRouter } from "./entries.js";

const router = Router({ mergeParams: true });
router.use("/entries", entriesRouter);

export default router;
