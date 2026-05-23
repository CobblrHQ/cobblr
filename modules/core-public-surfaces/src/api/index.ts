// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-public-surfaces/
// with requireAuth + withTenant. The PUBLIC read path
// /api/v1/public/:token is platform-mounted (see
// api/src/routes/public.ts) since it can't be slug-scoped.

import { Router } from "express";
import { surfacesRouter } from "./surfaces.js";

const router = Router({ mergeParams: true });

router.use("/surfaces", surfacesRouter);

export default router;
