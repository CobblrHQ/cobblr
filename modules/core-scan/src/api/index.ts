// core-scan router. Mounted at
//   /api/v1/orgs/:slug/modules/core-scan/.

import { Router } from "express";
import { startReceiptTrackingSweeper } from "../services/receipt-tracking-sweeper.js";
import { inboxRouter } from "./inbox.js";
import { organizeRouter } from "./organize.js";
import { putawayRouter } from "./putaway.js";
import { importRouter } from "./import.js";
import { exportRouter } from "./export.js";
import { entityImageRouter } from "./entity-image.js";
import { qrRulesRouter } from "./qr-rules.js";
import { decodeRouter } from "./decode.js";
import { registerScanHandlers } from "./handlers.js";
import { registerEmailInbound } from "../services/email-inbound.js";

registerScanHandlers();
registerEmailInbound();

// Follow parcels whose receipt is still in the inbox — filing should not
// be the price of being told your delivery arrived.
startReceiptTrackingSweeper();

const router = Router({ mergeParams: true });
router.use("/", inboxRouter);
router.use("/", organizeRouter); // Guided Organize: batch put-away plan + apply
router.use("/", putawayRouter); // put-away sessions: the shared execution engine (walk + Live Sort)
router.use("/", importRouter); // bulk import (inbox-export interop + generic CSV)
router.use("/", exportRouter); // bulk export (interop v1 envelope: JSON + CSV)
router.use("/", entityImageRouter);
router.use("/", qrRulesRouter);
router.use("/", decodeRouter); // identifier-decoder registry: POST /decode { code }

export default router;
