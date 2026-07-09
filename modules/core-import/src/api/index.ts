// core-import router. Mounted at /api/v1/orgs/:slug/modules/core-import/
// (requireAuth + withTenant already applied by the platform). One source
// adapter per system; Homebox is first. The homebox POST paths are body-parsed
// at a higher limit than the 1mb default in api/src/server.ts (a whole
// inventory's CSV rides in one { csv } body).

import { Router } from "express";
import { homeboxRouter } from "./homebox-import.js";

const router = Router({ mergeParams: true });
router.use("/", homeboxRouter);

export default router;
