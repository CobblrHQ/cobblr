// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-recurrence/
// with requireAuth + withTenant already applied by the platform.
//
// Exposes a single endpoint: POST /tick — synchronously runs one
// scheduler tick and returns the counts. Useful for tests + ops
// when you want to force-fire scheduled wires / per-entity events
// instead of waiting up to 60s for the next interval.

import { Router } from "express";
import { tick } from "./scheduler.js";

const router = Router({ mergeParams: true });

router.post("/tick", (req, res, next) => {
  void (async () => {
    // Default: scope to the current workspace so a tick from inside
    // a tenant only iterates that tenant's content. Without this,
    // a dev-DB with hundreds of leftover orgs blows the pg connection
    // pool. The setInterval-driven background tick keeps the
    // cross-tenant behavior.
    const tenant = (req as unknown as { tenant?: { org: { id: string } } }).tenant;
    const result = await tick({ orgId: tenant?.org.id });
    res.json(result);
  })().catch(next);
});

export default router;
