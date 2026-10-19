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
import { actionLabelsRouter } from "./action-labels.js";
import { registerLabelsHandlers } from "./handlers.js";
import { registerChangeQueuedLabelAction } from "./change-queued-label-action.js";
import { registerRemoveQueuedLabelAction } from "./remove-queued-label-action.js";
import { registerSaveSizeAction } from "./save-size-action.js";
import { registerRemoveSizeAction } from "./remove-size-action.js";

registerRemoveSizeAction();

registerSaveSizeAction();

registerRemoveQueuedLabelAction();

registerChangeQueuedLabelAction();

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
router.use("/action-labels", actionLabelsRouter);

export default router;
