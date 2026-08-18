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

// AI-REACH: drives a device or a preview surface, or is an operator/self-test probe
router.post("/tick", (req, res, next) => {
  // Ops/test endpoint: force-firing every scheduled wire for the workspace is
  // privileged — keep a read-only guest (or plain member) from triggering it.
  // (Audit 2026-06-26 P2.)
  const role = (req as unknown as { tenant?: { role?: string } }).tenant?.role;
  if (role && role !== "owner" && role !== "admin") {
    res.status(403).json({ error: { code: "forbidden", message: "This action requires owner or admin." } });
    return;
  }
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
