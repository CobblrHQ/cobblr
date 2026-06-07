// AI activity log — per workspace. A member sees their OWN calls (prompts +
// responses); owners/admins can see the whole workspace's. Full text is on the
// detail endpoint, not the list. (Cross-workspace review is the super-admin's
// /super-admin/ai-activity, which aggregates these across all tenant DBs.)

import { sql } from "kysely";
import { Router } from "express";
import { tenantContext, tenantDb, sessionUserId } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";

export const activityRouter = Router({ mergeParams: true });

// Retention: null out the FULL prompt/response (keep the metadata + short
// summaries) after N days. Runs lazily, fire-and-forget, when the log is
// viewed — no cron needed. COBBLR_AI_LOG_RETENTION_DAYS (default 90).
const RETENTION_DAYS = Number(process.env.COBBLR_AI_LOG_RETENTION_DAYS) || 90;
function purgeOldFullText(db: ReturnType<typeof tenantDb>): void {
  void db
    .updateTable("core_ai_calls")
    .set({ input_full: null, output_full: null })
    .where("invoked_at", "<", sql<Date>`now() - (${RETENTION_DAYS} || ' days')::interval`)
    .where((eb) => eb.or([eb("input_full", "is not", null), eb("output_full", "is not", null)]))
    .execute()
    .catch(() => {});
}

// GET /activity?scope=mine|workspace&limit=
activityRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    purgeOldFullText(db); // lazy retention
    const me = sessionUserId(req);
    const role = tenantContext(req).role;
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 300);
    const wantWorkspace = req.query.scope === "workspace";
    // Only owners/admins may see the whole workspace; everyone else → own only.
    const scopeWorkspace = wantWorkspace && (role === "owner" || role === "admin");

    let q = db
      .selectFrom("core_ai_calls")
      .select([
        "id",
        "user_id",
        "capability",
        "provider_id",
        "model",
        "input_summary",
        "output_summary",
        "input_tokens",
        "output_tokens",
        "cost_cents",
        "duration_ms",
        "ok",
        "error",
        "source_kind",
        "cached",
        "invoked_at",
      ])
      .orderBy("invoked_at", "desc")
      .limit(limit);
    if (!scopeWorkspace) q = q.where("user_id", "=", me);

    res.json({ items: await q.execute(), scope: scopeWorkspace ? "workspace" : "mine" });
  }),
);

// GET /activity/:id — full prompt + response. A member can only open their own;
// owners/admins can open any in the workspace.
activityRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const role = tenantContext(req).role;
    const me = sessionUserId(req);
    const row = await db
      .selectFrom("core_ai_calls")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Not found." } });
      return;
    }
    if (role !== "owner" && role !== "admin" && row.user_id !== me) {
      res.status(403).json({ error: { code: "forbidden", message: "That entry isn't yours." } });
      return;
    }
    res.json(row);
  }),
);
