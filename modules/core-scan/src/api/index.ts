// core-scan router. Mounted at
//   /api/v1/orgs/:slug/modules/core-scan/.

import { Router } from "express";
import { inboxRouter } from "./inbox.js";
import { importRouter } from "./import.js";
import { exportRouter } from "./export.js";
import { entityImageRouter } from "./entity-image.js";
import { qrRulesRouter } from "./qr-rules.js";
import { registerScanHandlers } from "./handlers.js";
import { registerEmailInbound } from "../services/email-inbound.js";

registerScanHandlers();
registerEmailInbound();

const router = Router({ mergeParams: true });
router.use("/", inboxRouter);
router.use("/", importRouter); // bulk import (companion app interop + generic CSV)
router.use("/", exportRouter); // bulk export (interop v1 envelope: JSON + CSV)
router.use("/", entityImageRouter);
router.use("/", qrRulesRouter);

export default router;
