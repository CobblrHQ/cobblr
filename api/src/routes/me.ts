// /api/v1/me — current session profile + org memberships. Mirrors
// the shape /auth/login returns so the web can reuse the same hook.

import { Router } from "express";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.session!.id;
  const orgs = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.name", "o.slug", "m.role"])
    .where("m.user_id", "=", userId)
    .execute();
  return res.json({ user: req.session, orgs });
});
