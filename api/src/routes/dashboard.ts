// /orgs/:slug/dashboard-layout
//
// Per-workspace ADMIN dashboard arrangement: the order + visibility of the
// home "at a glance" widgets. The widget ids belong to the web registry
// (registerDashboardWidget); this endpoint only persists their order + a
// hidden flag as JSONB on the org row (same storage pattern as portal_config).
//
//   GET /orgs/:slug/dashboard-layout   authed — current layout (or empty)
//   PUT /orgs/:slug/dashboard-layout   authed (owner/admin) — save arrangement
//   GET /orgs/:slug/dashboard          authed — every section's reads in one
//                                      answer (#6563, platform/dashboard-snapshot.ts)
//
// Members never see this dashboard (they get the portal), so editing is
// owner/admin only — but the layout is workspace-scoped, not per-user.

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { meta } from "../db/meta.js";
import { DashboardLayoutShape, saveDashboardLayout } from "../platform/dashboard-layout.js";
import { composeDashboardSnapshot } from "../platform/dashboard-snapshot.js";
import { todayFrom } from "../lib/due-day.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The caller's credentials, carried to each read so it answers as them. */
function callerHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v !== "string") continue;
    if (k === "authorization" || k === "x-impersonation" || k.startsWith("x-cobblr-")) out[k] = v;
  }
  return out;
}

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

// The dashboard in one request (#6563). `today` is the reader's day, and
// `from`/`to` the window their Up next asks for: the server cannot tell
// either from its own clock. Read-only: every read it makes is a GET the
// caller could make, answered as the caller.
// AI-REACH: ui-only — the page's own data in one answer; each section's read is its own route, and the assistant reaches those
dashboardRouter.get(
  "/:slug/dashboard",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const q = req.query as Record<string, unknown>;
      const day = (v: unknown) => (typeof v === "string" && DAY.test(v) ? v : null);
      const today = todayFrom(q.today);
      const from = day(q.from);
      const to = day(q.to);
      const rows = await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", req.tenant!.org.id).execute();
      const snapshot = await composeDashboardSnapshot({
        slug: req.params.slug!,
        today,
        upNext: from && to ? { from, to } : null,
        enabled: new Set(rows.map((r) => r.module_name)),
        headers: callerHeaders(req.headers),
      });
      res.set("Cache-Control", "no-store");
      res.json(snapshot);
    } catch (err) {
      next(err);
    }
  },
);
