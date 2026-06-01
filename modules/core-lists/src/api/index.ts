// core-lists router. Mounted at /api/v1/orgs/:slug/modules/core-lists/.
// Registers entity resolvers + the add-item action handler at load time.

import { Router } from "express";
import { listsRouter } from "./lists.js";
import { registerListResolvers } from "./resolvers.js";
import { registerListActionHandlers } from "./action-handlers.js";

registerListResolvers();
registerListActionHandlers();

const router = Router({ mergeParams: true });
router.use("/", listsRouter);

export default router;
