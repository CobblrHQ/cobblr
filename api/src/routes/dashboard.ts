// /orgs/:slug/dashboard-layout
//
// Per-workspace ADMIN dashboard arrangement: the order + visibility of the
// home "at a glance" widgets. The widget ids belong to the web registry
// (registerDashboardWidget); this endpoint only persists their order + a
// hidden flag as JSONB on the org row (same storage pattern as portal_config).
//
//   GET /orgs/:slug/dashboard-layout   authed — current layout (or empty)
//   PUT /orgs/:slug/dashboard-layout   authed (owner/admin) — save arrangement
//
// Members never see this dashboard (they get the portal), so editing is
// owner/admin only — but the layout is workspace-scoped, not per-user.

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { meta } from "../db/meta.js";
import { DashboardLayoutShape, saveDashboardLayout } from "../platform/dashboard-layout.js";

export const dashboardRouter = Router({ mergeParams: true });

dashboardRouter.get(
  "/:slug/dashboard-layout",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const row = await meta
        .selectFrom("orgs")
        .select(["dashboard_layout"])
        .where("id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      res.json({ layout: row?.dashboard_layout ?? { widgets: [] } });
    } catch (err) {
      next(err);
    }
  },
);

// AI-ACTION: platform:arrange-dashboard
dashboardRouter.put(
  "/:slug/dashboard-layout",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Arranging the dashboard is configuration: the admin tier, by rank.
      if (!(await requireCapability(req, res, "platform:arrange-dashboard"))) return;
      const parsed = DashboardLayoutShape.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad dashboard layout", details: parsed.error.issues },
        });
        return;
      }
      await saveDashboardLayout(req.tenant!.org.id, req.session!.id, parsed.data);
      res.json({ layout: parsed.data });
    } catch (err) {
      next(err);
    }
  },
);
