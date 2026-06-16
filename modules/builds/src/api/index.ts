// builds router. Mounted at /api/v1/orgs/:slug/modules/builds/.
// Registers entity resolvers + action handlers at load time.

import { Router } from "express";
import { buildsRouter } from "./builds.js";
import { registerBuildsResolvers } from "./resolvers.js";
import { registerBuildsActionHandlers } from "./action-handlers.js";

registerBuildsResolvers();
registerBuildsActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", buildsRouter);

export default router;
