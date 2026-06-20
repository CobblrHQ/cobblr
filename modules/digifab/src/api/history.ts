// /api/v1/orgs/:slug/modules/digifab/history — print history + at-a-glance stats.
//
// Read-only aggregate over digifab_jobs (the prints Cobblr sent + tracked to a
// terminal state). A summary (count, success rate, filament, hours) + the recent
// prints, over a window. Per-printer rollups so you can see which machine did
// what. No new storage — it's a read model on the jobs table.

import { Router } from "express";
import { sql } from "kysely";
import { tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";

export const historyRouter = Router({ mergeParams: true });

const TERMINAL = ["completed", "failed", "cancelled"];
const n = (v: unknown) => (v == null ? 0 : Number(v));

historyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86_400_000);

    const summary = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select([
        sql<number>`count(*)`.as("total"),
        sql<number>`count(*) filter (where status = 'completed')`.as("completed"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed"),
        sql<number>`count(*) filter (where status = 'cancelled')`.as("cancelled"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
        sql<number>`coalesce(sum(extract(epoch from (updated_at - created_at))) filter (where status = 'completed'), 0)`.as("seconds"),
      ])
      .executeTakeFirst();

    // Device names: prefer the user's linked machine label, else the remote name.
    const links = await db
      .selectFrom("digifab_device_links")
      .select(["connection_id", "remote_device_id", "machine_label", "remote_device_name"])
      .execute();
    const nameOf = (connId: string | null, dev: string | null) => {
      const l = links.find((x) => x.connection_id === connId && x.remote_device_id === dev);
      return l?.machine_label || l?.remote_device_name || dev || "—";
    };

    const recent = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select(["id", "file_ref", "connection_id", "target_device", "status", "material_grams", "created_at", "updated_at"])
      .orderBy("updated_at", "desc")
      .limit(50)
      .execute();

    // Per-(connection, device) rollup.
    const byDeviceRows = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .where("target_device", "is not", null)
      .groupBy(["connection_id", "target_device"])
      .select([
        "connection_id",
        "target_device",
        sql<number>`count(*)`.as("total"),
        sql<number>`count(*) filter (where status = 'completed')`.as("completed"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
      ])
      .execute();

    res.json({
      days,
      summary: {
        total: n(summary?.total),
        completed: n(summary?.completed),
        failed: n(summary?.failed),
        cancelled: n(summary?.cancelled),
        filament_g: n(summary?.filament_g),
        hours: Math.round((n(summary?.seconds) / 3600) * 10) / 10,
      },
      by_device: byDeviceRows.map((r) => ({
        name: nameOf(r.connection_id, r.target_device),
        total: n(r.total),
        completed: n(r.completed),
        failed: n(r.failed),
        filament_g: n(r.filament_g),
      })),
      recent: recent.map((r) => ({
        id: r.id,
        file_ref: r.file_ref,
        device: nameOf(r.connection_id, r.target_device),
        status: r.status,
        filament_g: r.material_grams == null ? null : Number(r.material_grams),
        at: r.updated_at,
      })),
    });
  }),
);
