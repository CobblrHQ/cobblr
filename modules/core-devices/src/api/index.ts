// core-devices router. Mounted at /api/v1/orgs/:slug/modules/core-devices/.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { linksRouter } from "./links.js";
import { ingestRouter } from "./ingest.js";
import { registerActionHandlers } from "./action-handlers.js";
import { connectionStore } from "../connection-store.js";

registerActionHandlers(); // core-devices:apply-to-linked-entity (the resolution seam)
platform().devices.registerConnectionStore(connectionStore); // core-devices owns connections

// Live-box capability: `scanner.bridge` — an enabled connection that advertises a
// scan/barcode source, so scan-driven live controls apply (else they self-hide).
// See docs/design-decisions/live-controls.md §3.2.
function advertisesScan(caps: unknown): boolean {
  if (Array.isArray(caps)) return caps.some((c) => /scan|barcode/i.test(String(c)));
  if (caps && typeof caps === "object") {
    const o = caps as Record<string, unknown>;
    return !!(o.scan || o.barcode) || Object.keys(o).some((k) => /scan|barcode/i.test(k));
  }
  return false;
}
platform().live.registerCapability("scanner.bridge", async (orgId) => {
  const conns = await connectionStore.list(orgId);
  return conns.some((c) => c.enabled && (advertisesScan(c.capabilities) || /scan/i.test(c.type)));
});

const router = Router({ mergeParams: true });
router.use("/links", linksRouter); // device → entity links (both surfaces)
router.use("/ingest", ingestRouter); // inbound device events (chip → Cobblr)

export default router;
