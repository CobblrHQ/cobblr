// /api/v1/orgs/:slug/modules/core-ai/usage — call audit log + spend
// summary. Two endpoints:
//   GET /calls            — recent call audit rows
//   GET /summary           — this-month spend rollup (by capability + provider)

import { Router } from "express";
import { sql } from "kysely";
import { tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";

export const usageRouter = Router({ mergeParams: true });

usageRouter.get(
  "/calls",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    const rows = await db
      .selectFrom("core_ai_calls")
      .selectAll()
      .orderBy("invoked_at", "desc")
      .limit(limit)
      .execute();
    res.json({ items: rows });
  }),
);

interface SummaryRow {
  capability: string;
  provider_id: string;
  calls: string | number;
  cached_calls: string | number;
  total_cost_cents: string | number | null;
  total_duration_ms: string | number | null;
  failed: string | number;
}

usageRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    const rows = (await db
      .selectFrom("core_ai_calls")
      .select([
        "capability",
        "provider_id",
        sql<number>`count(*)`.as("calls"),
        sql<number>`count(*) filter (where cached)`.as("cached_calls"),
        sql<number>`sum(cost_cents)`.as("total_cost_cents"),
        sql<number>`sum(duration_ms)`.as("total_duration_ms"),
        sql<number>`count(*) filter (where ok = false)`.as("failed"),
      ])
      .where("invoked_at", ">=", since)
      .groupBy(["capability", "provider_id"])
      .execute()) as unknown as SummaryRow[];
    res.json({ since: since.toISOString(), items: rows });
  }),
);
