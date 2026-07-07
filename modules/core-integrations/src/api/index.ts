// core-integrations router. Mounted at
//   /api/v1/orgs/:slug/modules/core-integrations/.
//
// Loaded once per server boot (lazily, via the module manifest's
// `api: () => import(...)`). The side-effect imports here register
// the built-in connectors + inbound handlers with the platform
// registry the first time this module's HTTP surface is touched.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { connectorsRouter } from "./connectors.js";
import { inboundTokensRouter } from "./inbound-tokens.js";
import { syncRouter } from "./sync.js";
import { sourceDefsRouter } from "./source-defs.js";
import { register as registerWebhook } from "../connectors/webhook.js";
import { register as registerHttp } from "../connectors/http.js";
import { register as registerSlack } from "../connectors/slack.js";
import { register as registerDiscord } from "../connectors/discord.js";
import { register as registerInboundWebhook } from "../connectors/inbound-webhook.js";
import { registerSyncInboundHandler } from "../sync/inbound.js";
import { registerSyncWorker } from "../sync/worker.js";
import { buildSyncConnector } from "../sync/declarative.js";
import { RAVELRY_MANIFEST } from "../sync/sources/ravelry.js";

let registered = false;
function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  registerWebhook();
  registerHttp();
  registerSlack();
  registerDiscord();
  registerInboundWebhook();
  // Sync sources are declarative manifests. Most are installed per workspace
  // (sync/declarative.ts + api/source-defs.ts); a few first-party ones ship as
  // BUILT-INS so they appear in every workspace's picker (opt-in) without the
  // user authoring JSON — still pure data (a manifest), nothing source-specific
  // in the engine. Ravelry is the first.
  platform().integrations.registerSyncConnector(buildSyncConnector(RAVELRY_MANIFEST));
  // The inbound handler (live push) + the reconcile worker are global.
  registerSyncInboundHandler();
  registerSyncWorker();
}

registerBuiltins();

const router = Router({ mergeParams: true });
router.use("/connectors", connectorsRouter);
router.use("/inbound-tokens", inboundTokensRouter);
router.use("/sync", syncRouter);
router.use("/sync-sources", sourceDefsRouter);

export default router;
