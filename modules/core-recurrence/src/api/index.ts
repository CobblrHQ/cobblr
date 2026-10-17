// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-recurrence/
// with requireAuth + withTenant already applied by the platform.
//
// Exposes a single endpoint: POST /tick — synchronously runs one
// scheduler tick and returns the counts. Useful for tests + ops
// when you want to force-fire scheduled wires / per-entity events
// instead of waiting up to 60s for the next interval.

import { Router } from "express";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { tick } from "./scheduler.js";
import { overdueTick } from "../overdue.js";

const router = Router({ mergeParams: true });

// AI-REACH: exempt — an operator's tick that fires every scheduled wire in the
// workspace at once; only the schedule's own clock may do that
// UI-REACH: an operator's tick of the recurrence sweep, which otherwise runs on its own
router.post("/tick", (req, res, next) => {
  // Ops/test endpoint: force-firing every scheduled wire for the workspace is
  // privileged — keep a read-only guest (or plain member) from triggering it.
  // (Audit 2026-06-26 P2.)
  const role = (req as unknown as { tenant?: { role?: string } }).tenant?.role;
  if (role && !roleSatisfies(role, ["owner", "admin"])) {
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

// AI-REACH: exempt — an operator's diagnostic that runs the daily overdue sweep
// now; it tells people nothing an agent could not wait for the schedule to do
// UI-REACH: an operator's run of the overdue sweep, which otherwise runs on its own
router.post("/overdue/sweep", (req, res, next) => {
  const tenant = (req as unknown as { tenant?: { org: { id: string }; role?: string } }).tenant;
  if (tenant?.role && !roleSatisfies(tenant.role, ["owner", "admin"])) {
    res.status(403).json({ error: { code: "forbidden", message: "This action requires owner or admin." } });
    return;
  }
  void (async () => {
    res.json(await overdueTick({ orgId: tenant?.org.id }));
  })().catch(next);
});

export default router;
