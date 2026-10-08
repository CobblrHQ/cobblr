// core-ai router. Mounted at /api/v1/orgs/:slug/modules/core-ai/.
//
// Built-in providers (openai, anthropic, ollama) register at module
// load time. New providers slot in by adding another register()
// import here.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { providersRouter } from "./providers.js";
import { capabilitiesRouter } from "./capabilities.js";
import { invokeRouter } from "./invoke.js";
import { usageRouter } from "./usage.js";
import { matchToCatalogRouter } from "./match-to-catalog.js";
import { chatRouter } from "./chat.js";
import { basicsRouter } from "./basics.js";
import { activityRouter } from "./activity.js";
import { register as registerOllama } from "../providers/ollama.js";
import { register as registerOpenAI } from "../providers/openai.js";
import { register as registerLocalOpenAI } from "../providers/local-openai.js";
import { register as registerOpenAICompat } from "../providers/openai-compat.js";
import { register as registerOpenRouter } from "../providers/openrouter.js";
import { register as registerGoogleAiStudio } from "../providers/google-ai-studio.js";
import { register as registerAnthropic } from "../providers/anthropic.js";
import { register as registerEdgeBridge } from "../providers/edge-bridge.js";
import { register as registerReplay } from "../providers/replay.js";
import { edgeStatusRouter } from "./edge-status.js";
import { registerServiceWriteModeSource } from "@cobblr/platform-contract/service-consent";

let registered = false;
function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  registerOllama();
  registerGoogleAiStudio();
  registerOpenAI();
  registerOpenAICompat();
  registerLocalOpenAI();
  // Shaped preset over the compat machinery: fixed base URL, required
  // key + model — "one key, any model" without knowing a base URL.
  registerOpenRouter();
  registerAnthropic();
  // Reaches an Ollama-API endpoint on the workspace's own device via a live
  // edge channel (the proprietary relay registers channels into platform().edge).
  // Credential-less; inert until an edge agent connects — usable on self-host too.
  registerEdgeBridge();
  // A recorded model for tests. Inert unless COBBLR_AI_REPLAY_DIR is set, so
  // it registers nothing on any real instance.
  registerReplay();
  // Edge-bridge consumer card for the generic Edge-bridges page: a personal
  // agent (set up in Your connections) routes AI capabilities to a model on
  // the user's own machine — Ollama, LM Studio, a local Claude bridge.
  platform().edge.registerConsumer({
    module: "core-ai",
    label: "Local AI",
    description:
      "Route AI capabilities to a model running on your own machine (Ollama, LM Studio, …). Set up a personal AI bridge under Your connections, then pick the edge provider in AI settings.",
    href: "/me/connections",
  });
  // A service job from Cobb or an MCP client follows the person's Changes
  // setting, which lives in this module's table; the kernel's gate asks here
  // rather than reading it (services.md section 9).
  registerServiceWriteModeSource(async (orgId, userId) => {
    const db = (await platform().tenants.getDb(orgId)) as unknown as {
      selectFrom: (t: string) => { select: (c: string[]) => { where: (a: string, o: string, v: string) => { executeTakeFirst: () => Promise<{ write_mode?: string } | undefined> } } };
    };
    const row = await db.selectFrom("core_ai_chat_prefs").select(["write_mode"]).where("user_id", "=", userId).executeTakeFirst();
    const m = row?.write_mode;
    return m === "off" || m === "auto" ? m : "ask";
  });
}

registerBuiltins();

const router = Router({ mergeParams: true });
router.use("/providers", providersRouter);
router.use("/capability-defaults", capabilitiesRouter);
router.use("/invoke", invokeRouter);
router.use("/usage", usageRouter);
router.use("/match-to-catalog", matchToCatalogRouter);
router.use("/chat", chatRouter);
router.use("/basics", basicsRouter);
router.use("/activity", activityRouter);
router.use("/edge-status", edgeStatusRouter);

export default router;
