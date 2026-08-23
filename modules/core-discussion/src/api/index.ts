// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-discussion/
// with requireAuth + withTenant already applied by the platform.
//
// Side effect on import: registers the action handlers, so Cobb and wires can
// reach the same conversation the UI writes to.

import { Router } from "express";
import { discussionRouter } from "./conversations.js";
import { registerDiscussionActionHandlers } from "./action-handlers.js";
import { registerCobbWorker } from "./cobb.js";

registerDiscussionActionHandlers();
registerCobbWorker();

const router = Router({ mergeParams: true });

router.use("/comments", discussionRouter);

export default router;
