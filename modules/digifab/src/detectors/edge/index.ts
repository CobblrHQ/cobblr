// Built-in `edge` detector — the LOCAL model on the machine's own bridge. Core
// calls driver.detectFailure(), which the edge-adapter routes to the bridge's
// GET /detect (a YOLO ONNX on the LAN). No frame leaves the network, no token
// cost. Was an inline branch in detectOnce; now a package behind the registry.

import type { DetectorPackage } from "../types.js";
import { clamp01 } from "../vision.js";

export const builtin: DetectorPackage = {
  key: "edge",
  name: "Local model (edge bridge)",
  summary: "A YOLO model on the machine's bridge, on the LAN. No token cost.",
  score: async (ctx) => {
    if (!ctx.driver?.detectFailure) return null;
    const r = await ctx.driver.detectFailure(ctx.deviceId);
    return r && typeof r.probability === "number" ? { probability: clamp01(r.probability) } : null;
  },
};
