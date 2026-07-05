// knowledge router. Mounted at /api/v1/orgs/:slug/modules/knowledge/.
// Registers entity resolvers at load time so core-views + cross-module reads
// resolve knowledge:entry without importing this module.

import { Router } from "express";
import { entriesRouter } from "./entries.js";
import { registerKnowledgeResolvers } from "./resolvers.js";

registerKnowledgeResolvers();

const router = Router({ mergeParams: true });
router.use("/", entriesRouter);

export default router;
