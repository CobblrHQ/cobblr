// tracking CRUD. Mounted at /api/v1/orgs/:slug/modules/tracking/
//   GET    /metrics                  all metrics + latest value + progress
//   POST   /metrics                  create a metric (name, unit, goal)
//   GET    /metrics/:id              one metric + its measurement series + progress
//   PATCH  /metrics/:id              edit name/unit/goal
//   DELETE /metrics/:id              delete (cascades measurements)
//   POST   /metrics/:id/measurements log a value
//   DELETE /measurements/:id         remove a data point

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { logMeasurement } from "./record.js";

export const metricsRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;
const ROLES = ["owner", "admin", "member"] as const;
const num = (v: string | null) => (v == null ? null : Number(v));

/** Progress toward goal as 0..1, direction-aware. null if no goal/data. */
function progress(latest: number | null, goal: number | null, dir: string, first: number | null): number | null {
  if (latest == null || goal == null) return null;
  if (dir === "up") return goal === 0 ? null : Math.max(0, Math.min(1, latest / goal));
  if (dir === "down") {
    // from a starting point down to goal; needs a baseline (first reading)
    if (first == null || first <= goal) return latest <= goal ? 1 : null;
    return Math.max(0, Math.min(1, (first - latest) / (first - goal)));
  }
  // "hit": closeness to target, within 10% band = done
  if (goal === 0) return latest === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - Math.abs(latest - goal) / Math.abs(goal)));
}

const MetricCreate = z.object({
  name: z.string().min(1).max(200),
  unit: z.string().max(40).optional(),
  goal_value: z.number().optional(),
  goal_direction: z.enum(["up", "down", "hit"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});
const MetricUpdate = MetricCreate.partial();

async function latestFor(req: Parameters<typeof tenantDb>[0], metricId: string): Promise<{ latest: number | null; first: number | null; count: number }> {
  const db = tenantDb(req);
  const rows = await db
    .selectFrom("tracking_measurements")
    .select(["value", "measured_at"])
    .where("metric_id", "=", metricId)
    .orderBy("measured_at", "asc")
    .execute();
  if (rows.length === 0) return { latest: null, first: null, count: 0 };
  return { latest: Number(rows[rows.length - 1]!.value), first: Number(rows[0]!.value), count: rows.length };
}

metricsRouter.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const metrics = await db.selectFrom("tracking_metrics").selectAll().orderBy("created_at", "desc").execute();
    const out = [];
    for (const m of metrics) {
      const { latest, first, count } = await latestFor(req, m.id);
      const goal = num(m.goal_value);
      out.push({
        ...m,
        goal_value: goal,
        latest_value: latest,
        measurement_count: count,
        progress: progress(latest, goal, m.goal_direction, first),
      });
    }
    res.json({ items: out });
  }),
);

metricsRouter.post(
  "/metrics",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = MetricCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .insertInto("tracking_metrics")
      .values({
        name: parsed.data.name,
        unit: parsed.data.unit ?? null,
        goal_value: parsed.data.goal_value != null ? String(parsed.data.goal_value) : null,
        goal_direction: parsed.data.goal_direction ?? "hit",
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("tracking.metric.created", { orgId: ctx.org.id, metricId: row.id });
    res.status(201).json({ ...row, goal_value: num(row.goal_value), latest_value: null, measurement_count: 0, progress: null });
  }),
);

metricsRouter.get(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const m = await db.selectFrom("tracking_metrics").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!m) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });
    const series = await db
      .selectFrom("tracking_measurements")
      .select(["id", "value", "measured_at", "note"])
      .where("metric_id", "=", req.params.id!)
      .orderBy("measured_at", "asc")
      .execute();
    const points = series.map((s) => ({ id: s.id, value: Number(s.value), measured_at: s.measured_at, note: s.note }));
    const goal = num(m.goal_value);
    const latest = points.length ? points[points.length - 1]!.value : null;
    const first = points.length ? points[0]!.value : null;
    res.json({
      ...m,
      goal_value: goal,
      measurements: points,
      latest_value: latest,
      progress: progress(latest, goal, m.goal_direction, first),
    });
  }),
);

metricsRouter.patch(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = MetricUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.unit !== undefined) patch.unit = parsed.data.unit;
    if (parsed.data.goal_value !== undefined) patch.goal_value = parsed.data.goal_value == null ? null : String(parsed.data.goal_value);
    if (parsed.data.goal_direction !== undefined) patch.goal_direction = parsed.data.goal_direction;
    if (parsed.data.metadata !== undefined) patch.metadata = jsonb(parsed.data.metadata);
    const row = await db.updateTable("tracking_metrics").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });
    res.json({ ...row, goal_value: num(row.goal_value) });
  }),
);

metricsRouter.delete(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    await db.deleteFrom("tracking_metrics").where("id", "=", req.params.id!).execute();
    void platform().events.emit("tracking.metric.deleted", { orgId: ctx.org.id, metricId: req.params.id });
    res.status(204).end();
  }),
);

const MeasurementCreate = z.object({
  value: z.number(),
  measured_at: z.string().datetime().optional(),
  note: z.string().max(2000).optional(),
});

// AI-ACTION: tracking:log-measurement
metricsRouter.post(
  "/metrics/:id/measurements",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = MeasurementCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const metric = await db.selectFrom("tracking_metrics").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!metric) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });
    // Shared path: insert + measurement.logged + goal.reached + notify.
    const row = await logMeasurement({
      db,
      orgId: ctx.org.id,
      metric,
      value: parsed.data.value,
      note: parsed.data.note ?? null,
      measuredAt: parsed.data.measured_at ? new Date(parsed.data.measured_at) : undefined,
    });
    res.status(201).json({ ...row, value: Number(row.value) });
  }),
);

metricsRouter.delete(
  "/measurements/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    await db.deleteFrom("tracking_measurements").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);
