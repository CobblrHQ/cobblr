// GET /orgs/:slug/live — the applicable live controls for this workspace (the
// Live box's whole input). Returns every enabled module's exposes.live control
// whose `requires` capability the workspace currently satisfies; an empty list
// means the box renders nothing. See docs/design-decisions/live-controls.md.

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { applicable } from "../platform/live.js";

export const liveRouter = Router({ mergeParams: true });

liveRouter.get("/:slug/live", requireAuth, withTenant, async (req, res, next) => {
  try {
    const controls = await applicable(req.tenant!.org.id);
    res.json({ controls });
  } catch (err) {
    next(err);
  }
});
