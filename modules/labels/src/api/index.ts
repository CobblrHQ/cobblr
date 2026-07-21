// Default-exported Router. Mounted by the platform at
// /api/v1/orgs/:slug/modules/labels/ with requireAuth +
// withTenant pre-applied.
//
// Side effect on import: registers the labels:print action handler
// with the platform.

import { Router } from "express";
import { queueRouter } from "./queue.js";
import { printRouter } from "./print.js";
import { browseRouter } from "./browse.js";
import { codesRouter } from "./codes.js";
import { qrTokensRouter } from "./qr-tokens.js";
import { qrSettingsRouter } from "./qr-settings.js";
import { sizesRouter } from "./sizes.js";
import { autoflushRouter } from "./autoflush.js";
import { registerLabelsHandlers } from "./handlers.js";

registerLabelsHandlers();

const router = Router({ mergeParams: true });

router.use("/queue", queueRouter);
router.use("/print", printRouter);
router.use("/browse", browseRouter);
router.use("/codes", codesRouter);
router.use("/qr/tokens", qrTokensRouter);
router.use("/qr/settings", qrSettingsRouter);
router.use("/sizes", sizesRouter);
router.use("/autoflush", autoflushRouter);

// Old-shape alias for the former core-labels-qr module's paths
// (/modules/core-labels-qr/{tokens,settings}). The platform mounts this at
// the old module segment during the merge-compat window; retire together
// with migration 0004's compat views once no client ships the old paths.
export const qrCompatRouter = Router({ mergeParams: true });
qrCompatRouter.use("/tokens", qrTokensRouter);
qrCompatRouter.use("/settings", qrSettingsRouter);

export default router;
