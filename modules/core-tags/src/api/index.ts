// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-tags/
// with requireAuth + withTenant already applied by the platform.
//
// Side effects on import: registers the tag entity resolver +
// list resolver, and the tag/untag action handlers.

import { Router } from "express";
import { tagsRouter } from "./tags.js";
import { registerTagResolvers } from "./resolvers.js";
import { registerTagActionHandlers } from "./action-handlers.js";

registerTagResolvers();
registerTagActionHandlers();

const router = Router({ mergeParams: true });

router.use("/", tagsRouter);

export default router;
