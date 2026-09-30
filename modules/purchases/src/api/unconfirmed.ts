// /modules/purchases/unconfirmed-receipts: the lines of orders marked arrived
// whose stock may never have been added (heal-unreceived-arrivals.ts), and a
// person's answer for each: add it to stock now, or it was already counted.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { settleUnconfirmedLine } from "../receive.js";

export const unconfirmedRouter = Router({ mergeParams: true });

unconfirmedRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const rows = await db
      .selectFrom("purchases_order_items as i")
      .innerJoin("purchases_orders as o", "o.id", "i.order_id")
      .select(["i.id", "i.order_id", "i.part_id", "i.qty", "i.description", "o.vendor", "o.order_number", "o.arrived_at"])
      .where("i.receipt_unconfirmed", "=", true)
      .orderBy("o.arrived_at", "desc")
      .execute();
    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        order_id: r.order_id,
        vendor: r.vendor,
        order_number: r.order_number,
        arrived_at: r.arrived_at,
        description: r.description,
        qty: Number(r.qty ?? 0),
        part_id: r.part_id,
        part_title: r.part_id ? await platform().entities.titleForEntity(orgId, "inventory:part", r.part_id).catch(() => null) : null,
      })),
    );
    res.json({ items });
  }),
);

// AI-REACH: exempt — a person says what is really on their shelf; the answer cannot be guessed, and adding stock twice is the harm it exists to prevent
unconfirmedRouter.post(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = z.object({ decision: z.enum(["add", "counted"]) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const settled = await settleUnconfirmedLine(tenantDb(req), orgId, String(req.params.id), parsed.data.decision);
    if (settled) {
      await platform().activity.log({
        orgId,
        userId: sessionUser(req)?.id ?? null,
        action: parsed.data.decision === "add" ? "receipt_added_to_stock" : "receipt_already_counted",
        ref: { module: "purchases", entityType: "order_item", entityId: String(req.params.id) },
        diff: { decision: parsed.data.decision },
      });
    }
    res.json({ settled });
  }),
);
