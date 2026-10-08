import { assemblyOrdersRouter, registerAssemblyOrderActions } from "./assembly-orders.js";
import { boardRevisionsRouter, registerBoardRevisionActions } from "./board-revisions.js";
// builds router. Mounted at /api/v1/orgs/:slug/modules/builds/.
// Registers entity resolvers + action handlers at load time.

import { Router } from "express";
import { buildsRouter } from "./builds.js";
import { registerBuildsResolvers } from "./resolvers.js";
import { registerBuildsActionHandlers } from "./action-handlers.js";

registerBoardRevisionActions();
registerAssemblyOrderActions();
registerBuildsResolvers();
registerBuildsActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", boardRevisionsRouter);
router.use("/", assemblyOrdersRouter);
router.use("/", buildsRouter);

export default router;
