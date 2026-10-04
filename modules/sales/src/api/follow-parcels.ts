// /follow-parcels: the "Follow parcels I send" setting, and "Check now".
// The sweep itself is ../follow-parcels.ts.

import { Router } from "express";
import { z } from "zod";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { followRound, readFollowSetting, setFollowing } from "../follow-parcels.js";

import { readDeliveryCloseSetting, setDeliveryCloseSetting } from "../close-delivered.js";

export const followParcelsRouter = Router({ mergeParams: true });

/** The setting, and how many sent parcels are being followed right now. */
followParcelsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const setting = await readFollowSetting(db);
    const following = await db
      .selectFrom("sales_orders")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("status", "in", ["shipped", "closed"])
      .where("tracking_number", "is not", null)
      .where("delivered_at", "is", null)
      .executeTakeFirst();
    res.json({ ...setting, close_delivered_orders: await readDeliveryCloseSetting(db), following: Number(following?.n ?? 0) });
  }),
);

const Toggle = z.object({ on: z.boolean() });
// AI-REACH: exempt — a person opts in from Sales settings; it is theirs, because the sweep then asks with their own connection
followParcelsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const body = Toggle.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const next = await setFollowing(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, body.data.on);
    res.json(next);
  }),
);

// AI-REACH: exempt — "Check now" on the settings panel; the sweep asks on its own every hour
followParcelsRouter.post(
  "/check",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const r = await followRound(tenantDb(req), tenantContext(req).org.id, new Date(), { ignorePause: true });
    res.json(r);
  }),
);

const CloseToggle = z.object({ on: z.boolean() });
// AI-REACH: exempt — a workspace preference controlled from Sales settings
followParcelsRouter.put("/close-delivered", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const body = CloseToggle.safeParse(req.body ?? {});
  if (!body.success) return badBody(res, body.error);
  await setDeliveryCloseSetting(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, body.data.on);
  res.json({ on: body.data.on });
}));
