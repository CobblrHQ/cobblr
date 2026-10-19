import { personalDocumentsRouter } from "./personal-documents.js";
import { registerPersonalDocumentReader } from "@cobblr/platform-contract/personal-documents";
import { readPersonalDocumentLocally } from "../services/personal-document.js";
// core-scan router. Mounted at
//   /api/v1/orgs/:slug/modules/core-scan/.

import { Router } from "express";
import { startReceiptTrackingSweeper } from "../services/receipt-tracking-sweeper.js";
import { startReceiptAnswerSync } from "../services/receipt-answers.js";
import { startPicturesSweeper } from "../services/pictures-sweeper.js";
import { inboxRouter } from "./inbox.js";
import { lineUnitsRouter } from "./line-units.js";
import { organizeRouter } from "./organize.js";
import { putawayRouter } from "./putaway.js";
import { importRouter } from "./import.js";
import { exportRouter } from "./export.js";
import { entityImageRouter } from "./entity-image.js";
import { recordPhotosRouter } from "./record-photos.js";
import { qrRulesRouter } from "./qr-rules.js";
import { barcodeLookupRouter } from "./barcode-lookup.js";
import { decodeRouter } from "./decode.js";
import { feedRouter } from "./feed.js";
import { stationsRouter } from "./stations.js";
import { duplicatesRouter } from "./duplicates.js";
import { shipmentEventRouter } from "./shipment-event.js";
import { registerScanHandlers } from "./handlers.js";
import { registerEmailInbound } from "../services/email-inbound.js";
import { registerOperatorServices } from "../services/operator-services.js";
import { offerIntake } from "../services/offer-intake.js";
import { offersRouter } from "./offers.js";
import { platform } from "@cobblr/platform-contract";
import { registerAddThingsFromPhotoAction } from "./add-things-from-photo-action.js";
import { registerUndoSplitAction } from "./undo-split-action.js";
import { registerRedoSplitAction } from "./redo-split-action.js";
import { registerRanOutAction } from "./ran-out-action.js";
import { registerMarkBrokenAction } from "./mark-broken-action.js";
import { registerUnmarkBrokenAction } from "./unmark-broken-action.js";

registerRanOutAction();
registerMarkBrokenAction();
registerUnmarkBrokenAction();

registerUndoSplitAction();
registerRedoSplitAction();

registerAddThingsFromPhotoAction();

registerPersonalDocumentReader(readPersonalDocumentLocally);
registerScanHandlers();
registerEmailInbound();
registerOperatorServices();
// Things offered over a share land in this inbox (share-offer.ts).
platform().scan.registerOfferIntake(offerIntake);

// Follow parcels whose receipt is still in the inbox — filing should not
// be the price of being told your delivery arrived.
startReceiptTrackingSweeper();
// An order marked arrived (its button, its page) settles the receipt made it.
startReceiptAnswerSync();
// A pending row with no picture is asked again on its own; something is
// better than nothing, and finding it is not the person's job.
startPicturesSweeper();

const router = Router({ mergeParams: true });
// Before the inbox router: its /inbox/:id routes would take /inbox/offer-to-sharer.
router.use("/", personalDocumentsRouter);
router.use("/", offersRouter);
// Before the inbox's own routes: /inbox/line-slots is not an item id (#5734).
router.use("/", lineUnitsRouter);
router.use("/", inboxRouter);
router.use("/", shipmentEventRouter);
router.use("/", organizeRouter); // Guided Organize: batch put-away plan + apply
router.use("/", duplicatesRouter); // find + merge records that are the same thing twice
router.use("/", putawayRouter); // put-away sessions: the shared execution engine (walk + Live Sort)
router.use("/", importRouter); // bulk import (inbox-export interop + generic CSV)
router.use("/", exportRouter); // bulk export (interop v1 envelope: JSON + CSV)
router.use("/", entityImageRouter);
router.use("/", recordPhotosRouter); // pictures suggested for records made without one
router.use("/", qrRulesRouter);
router.use("/", barcodeLookupRouter);
router.use("/", decodeRouter); // identifier-decoder registry: POST /decode { code }
router.use("/", feedRouter); // live feed: the last few captures, for a screen that is not the scanner
router.use("/", stationsRouter); // a Station: a tablet a barcode scanner drives (#4640)

export default router;
