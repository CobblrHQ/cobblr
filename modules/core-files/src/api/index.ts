// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-files/
// by the platform, with requireAuth + withTenant already applied.
//
// Side effects on import: registers the file entity resolver so
// platform.entities.lookup("core-files:file", id) works.

import { Router } from "express";
import { attachmentsRouter } from "./attachments.js";
import { filesRouter } from "./files.js";
import { registerFileResolvers } from "./resolvers.js";

registerFileResolvers();

const router = Router({ mergeParams: true });

router.use("/files", filesRouter);
router.use("/attachments", attachmentsRouter);

export default router;
