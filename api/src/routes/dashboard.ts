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
import { z } from "zod";
import { sql } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import * as activity from "../platform/activity.js";

export const dashboardRouter = Router({ mergeParams: true });

const DashboardLayoutShape = z.object({
  widgets: z
    .array(
      z.object({
        // Opaque to the server — owned by the web registry. Bounded so a
        // bad client can't store unbounded ids.
        id: z.string().min(1).max(120),
        hidden: z.boolean().default(false),
      }),
    )
    .max(200)
    .default([]),
});

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

dashboardRouter.put(
  "/:slug/dashboard-layout",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Only admins/owners arrange the workspace dashboard.
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({ error: { code: "forbidden", message: "Admins only." } });
        return;
      }
      const parsed = DashboardLayoutShape.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad dashboard layout", details: parsed.error.issues },
        });
        return;
      }
      await meta
        .updateTable("orgs")
        .set({
          dashboard_layout: sql`${JSON.stringify(parsed.data)}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", req.tenant!.org.id)
        .execute();
      await activity.log({
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        action: "dashboard_layout_updated",
        ref: { module: null, entityType: "org", entityId: req.tenant!.org.id },
        diff: {
          widgets: parsed.data.widgets.length,
          hidden: parsed.data.widgets.filter((w) => w.hidden).length,
        },
      });
      res.json({ layout: parsed.data });
    } catch (err) {
      next(err);
    }
  },
);
