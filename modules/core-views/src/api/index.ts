// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-views/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { viewsRouter } from "./views.js";
import { registerViewsHandlers } from "./handlers.js";
import { registerWireViewReader } from "./saved-view-reader.js";

// The workspace-scoped action's handler, so "make me a board of my open tasks"
// is reachable through invoke_action and not only through this router.
registerViewsHandlers();
// A wire narrowed to "the records this view shows" reads the view through
// the contract (saved-view-reader.ts, #6070).
registerWireViewReader();

const router = Router({ mergeParams: true });

router.use("/views", viewsRouter);

export default router;
