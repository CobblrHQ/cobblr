// core-scan router. Mounted at
//   /api/v1/orgs/:slug/modules/core-scan/.

import { Router } from "express";
import { inboxRouter } from "./inbox.js";
import { entityImageRouter } from "./entity-image.js";
import { qrRulesRouter } from "./qr-rules.js";
import { registerScanHandlers } from "./handlers.js";
import { registerEmailInbound } from "../services/email-inbound.js";

registerScanHandlers();
registerEmailInbound();

const router = Router({ mergeParams: true });
router.use("/", inboxRouter);
router.use("/", entityImageRouter);
router.use("/", qrRulesRouter);

export default router;
