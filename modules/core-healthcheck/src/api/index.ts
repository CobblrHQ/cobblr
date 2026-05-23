// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-healthcheck/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { platform, type HealthProbeResult } from "@cobblr/platform-contract";

const router = Router({ mergeParams: true });

router.get("/snapshot", (_req, res, next) => {
  void (async () => {
    const probes = await platform().health.snapshot();
    const rollup = rollupStatus(probes);
    const httpStatus = rollup === "error" ? 503 : 200;
    res.status(httpStatus).json({ status: rollup, probes });
  })().catch(next);
});

function rollupStatus(
  probes: Record<string, HealthProbeResult>,
): "ok" | "degraded" | "error" {
  let degraded = false;
  for (const p of Object.values(probes)) {
    if (p.status === "error") return "error";
    if (p.status === "degraded") degraded = true;
  }
  return degraded ? "degraded" : "ok";
}

export default router;
