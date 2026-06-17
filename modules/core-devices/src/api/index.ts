// core-devices router. Mounted at /api/v1/orgs/:slug/modules/core-devices/.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { linksRouter } from "./links.js";
import { ingestRouter } from "./ingest.js";
import { registerActionHandlers } from "./action-handlers.js";
import { connectionStore } from "../connection-store.js";

registerActionHandlers(); // core-devices:apply-to-linked-entity (the resolution seam)
platform().devices.registerConnectionStore(connectionStore); // core-devices owns connections

const router = Router({ mergeParams: true });
router.use("/links", linksRouter); // device → entity links (both surfaces)
router.use("/ingest", ingestRouter); // inbound device events (chip → Cobblr)

export default router;
