import { Router } from "express";
import { z } from "zod";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { tenantContext } from "../db.js";
import { alertMeta } from "../low-stock-alerts.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const lowStockAlertsRouter = Router();
lowStockAlertsRouter.get("/", asyncHandler(async (req, res) => {
  const { org, role } = tenantContext(req);
  const row = await alertMeta().selectFrom("orgs").select("low_stock_alerts").where("id", "=", org.id).executeTakeFirstOrThrow();
  res.json({ enabled: row.low_stock_alerts, canManage: roleSatisfies(role, ["owner", "admin"]) });
}));

// AI-REACH: exempt workspace-wide notification consent is an owner's choice beside the stock list.
lowStockAlertsRouter.put("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  await alertMeta().updateTable("orgs").set({ low_stock_alerts: parsed.data.enabled })
    .where("id", "=", tenantContext(req).org.id).execute();
  res.json({ enabled: parsed.data.enabled, canManage: true });
}));
