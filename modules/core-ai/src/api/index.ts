// core-ai router. Mounted at /api/v1/orgs/:slug/modules/core-ai/.
//
// Built-in providers (openai, anthropic, ollama) register at module
// load time. New providers slot in by adding another register()
// import here.

import { Router } from "express";
import { providersRouter } from "./providers.js";
import { capabilitiesRouter } from "./capabilities.js";
import { invokeRouter } from "./invoke.js";
import { usageRouter } from "./usage.js";
import { matchToCatalogRouter } from "./match-to-catalog.js";
import { chatRouter } from "./chat.js";
import { activityRouter } from "./activity.js";
import { register as registerOllama } from "../providers/ollama.js";
import { register as registerOpenAI } from "../providers/openai.js";
import { register as registerAnthropic } from "../providers/anthropic.js";

let registered = false;
function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  registerOllama();
  registerOpenAI();
  registerAnthropic();
}

registerBuiltins();

const router = Router({ mergeParams: true });
router.use("/providers", providersRouter);
router.use("/capability-defaults", capabilitiesRouter);
router.use("/invoke", invokeRouter);
router.use("/usage", usageRouter);
router.use("/match-to-catalog", matchToCatalogRouter);
router.use("/chat", chatRouter);
router.use("/activity", activityRouter);

export default router;
