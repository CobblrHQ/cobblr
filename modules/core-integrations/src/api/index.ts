// core-integrations router. Mounted at
//   /api/v1/orgs/:slug/modules/core-integrations/.
//
// Loaded once per server boot (lazily, via the module manifest's
// `api: () => import(...)`). The side-effect imports here register
// the built-in connectors + inbound handlers with the platform
// registry the first time this module's HTTP surface is touched.

import { Router } from "express";
import { connectorsRouter } from "./connectors.js";
import { inboundTokensRouter } from "./inbound-tokens.js";
import { register as registerWebhook } from "../connectors/webhook.js";
import { register as registerHttp } from "../connectors/http.js";
import { register as registerSlack } from "../connectors/slack.js";
import { register as registerDiscord } from "../connectors/discord.js";
import { register as registerInboundWebhook } from "../connectors/inbound-webhook.js";

let registered = false;
function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  registerWebhook();
  registerHttp();
  registerSlack();
  registerDiscord();
  registerInboundWebhook();
}

registerBuiltins();

const router = Router({ mergeParams: true });
router.use("/connectors", connectorsRouter);
router.use("/inbound-tokens", inboundTokensRouter);

export default router;
