// /api/v1/orgs/* — org-scoped routes. Composes requireAuth +
// withTenant on every endpoint so handlers can rely on req.tenant.
//
// Milestone 3 ships just /local, which queries the tenant's
// platform_local table — proves end-to-end that:
//   1. The tenant DB exists
//   2. The tenant user can connect to it
//   3. The base-tenant migrations ran
//   4. The auth + routing middleware correctly swaps Kysely instances
//   5. Two different orgs see two different `platform_local`
//      contents (different `created_at` values)

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import * as notifications from "../platform/notifications.js";

export const orgsRouter = Router();

orgsRouter.get("/:slug/local", requireAuth, withTenant, async (req, res, next) => {
  try {
    const rows = await req.tenant!.db
      .selectFrom("platform_local")
      .select(["key", "value", "updated_at"])
      .orderBy("key")
      .execute();
    res.json({
      org: req.tenant!.org,
      role: req.tenant!.role,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:slug/activity", requireAuth, withTenant, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const items = await activity.list({ orgId: req.tenant!.org.id, limit });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:slug/notifications", requireAuth, withTenant, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const unreadOnly = req.query.unread === "1";
    const items = await notifications.listForUser(req.session!.id, req.tenant!.org.id, {
      limit,
      unreadOnly,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
