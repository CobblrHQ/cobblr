// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-views/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { viewsRouter } from "./views.js";
import { registerViewsHandlers } from "./handlers.js";

// The workspace-scoped action's handler, so "make me a board of my open tasks"
// is reachable through invoke_action and not only through this router.
registerViewsHandlers();

const router = Router({ mergeParams: true });

router.use("/views", viewsRouter);

export default router;
