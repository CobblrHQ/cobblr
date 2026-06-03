// core-file-preview router. Mounted at
//   /api/v1/orgs/:slug/modules/core-file-preview/.
// Only the installed-renderer store needs a server side; the rendering
// itself is entirely client-side (and sandboxed).

import { Router } from "express";
import { renderersRouter } from "./renderers.js";

const router = Router({ mergeParams: true });
router.use("/renderers", renderersRouter);

export default router;
