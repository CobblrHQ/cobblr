// tracking CRUD. Mounted at /api/v1/orgs/:slug/modules/tracking/
//   GET    /metrics                  all metrics + latest value + progress
//   POST   /metrics                  create a metric (name, unit, goal)
//   GET    /metrics/:id              one metric + its measurement series + progress
//   PATCH  /metrics/:id              edit name/unit/goal
//   DELETE /metrics/:id              delete (cascades measurements)
//   POST   /metrics/:id/measurements log a value
//   GET    /measurements/:id         one data point
//   DELETE /measurements/:id         remove a data point

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { goalReached, logMeasurement, removeMeasurement } from "./record.js";
import { instantFromInput } from "@cobblr/platform-contract/day";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { readableNameField } from "@cobblr/platform-contract/readable-text";

export const metricsRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;
const num = (v: string | null) => (v == null ? null : Number(v));

/** Progress toward goal as 0..1, direction-aware. null only with no goal or no
 *  reading: the bar says "no goal" for null, so a goal with a reading always
 *  has a number, and a goal met is always full, by the same test that tells
 *  people it was reached. */
function progress(latest: number | null, goal: number | null, dir: string, first: number | null): number | null {
  if (latest == null || goal == null) return null;
  if (goalReached(latest, goal, dir)) return 1;
  if (dir === "up") return goal <= 0 ? 0 : Math.max(0, latest / goal);
  if (dir === "down") return first == null || first <= goal ? 0 : Math.max(0, (first - latest) / (first - goal));
  if (goal === 0) return 0;
  return Math.max(0, 1 - Math.abs(latest - goal) / Math.abs(goal));
}

/** A box left with only spaces in it is left blank. */
const blankIsNone = (max: number) => optionalField(z.string().trim().max(max).transform((text) => text || null));

const MetricCreate = z.object({
  name: readableNameField(200),
  unit: blankIsNone(40),
  // JSON can spell a number too large to hold (1e400), which parses as Infinity
  // and reads back as null.
  goal_value: optionalField(z.number().finite()),
  goal_direction: z.enum(["up", "down", "hit"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
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
    .orderBy("created_at", "asc")
    .execute();
  if (rows.length === 0) return { latest: null, first: null, count: 0 };
  return { latest: Number(rows[rows.length - 1]!.value), first: Number(rows[0]!.value), count: rows.length };
}

metricsRouter.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
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

// AI-REACH: crud
metricsRouter.post(
  "/metrics",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const parsed = MetricCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await platform().activity.transaction(ctx.org.id, db, async (trx, log) => {
      const row = await trx
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
      await log({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        action: "metric_created",
        ref: { module: "tracking", entityType: "metric", entityId: row.id },
        diff: { name: row.name },
      });
      return row;
    });
    void platform().events.emit("tracking.metric.created", { orgId: ctx.org.id, metricId: row.id });
    res.status(201).json({ ...row, goal_value: num(row.goal_value), latest_value: null, measurement_count: 0, progress: null });
  }),
);

metricsRouter.get(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const m = await db.selectFrom("tracking_metrics").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!m) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });
    const series = await db
      .selectFrom("tracking_measurements")
      .select(["id", "value", "measured_at", "note"])
      .where("metric_id", "=", req.params.id!)
      .orderBy("measured_at", "asc")
      .orderBy("created_at", "asc")
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

// AI-REACH: crud
metricsRouter.patch(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const parsed = MetricUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.unit !== undefined) patch.unit = parsed.data.unit;
    if (parsed.data.goal_value !== undefined) patch.goal_value = parsed.data.goal_value == null ? null : String(parsed.data.goal_value);
    if (parsed.data.goal_direction !== undefined) patch.goal_direction = parsed.data.goal_direction;
    // The custom fields MERGE into the live row (#3625).
    if (parsed.data.metadata !== undefined) patch.metadata = platform().db.mergeJsonb("metadata", parsed.data.metadata as Record<string, unknown>) as never;
    // The row as it was: the log says what this edit changed (#4517).
    const before = await db.selectFrom("tracking_metrics").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    const row = await platform().activity.transaction(tenantContext(req).org.id, db, async (trx, log) => {
      const row = await trx.updateTable("tracking_metrics").set(patch).where("id", "=", req.params.id!).returningAll().executeTakeFirst();
      // The request as sent, on the record's history: the one place a value
      // a later write replaced can still be read back (#3625).
      if (row) await log({
        orgId: tenantContext(req).org.id,
        userId: sessionUser(req)?.id ?? null,
        action: "metric_updated",
        ref: { module: "tracking", entityType: "metric", entityId: String(req.params.id) },
        diff: parsed.data as Record<string, unknown>,
        before,
      });
      return row;
    });
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });

    res.json({ ...row, goal_value: num(row.goal_value) });
  }),
);

// AI-REACH: crud
metricsRouter.delete(
  "/metrics/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const gone = await platform().activity.transaction(ctx.org.id, db, async (trx, log) => {
      const row = await trx.deleteFrom("tracking_metrics").where("id", "=", req.params.id!).returning(["id", "name"]).executeTakeFirst();
      if (row) await log({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        action: "metric_deleted",
        ref: { module: "tracking", entityType: "metric", entityId: row.id },
        diff: { name: row.name },
      });
      return row;
    });
    if (!gone) return void res.status(404).json({ error: { code: "not_found", message: "Metric not found." } });
    void platform().events.emit("tracking.metric.deleted", { orgId: ctx.org.id, metricId: req.params.id });
    res.status(204).end();
  }),
);

// A day's grace for a clock that runs ahead. A reading dated further on would
// stay the metric's latest until the calendar reached it.
const LATEST_READING_AHEAD_MS = 24 * 60 * 60 * 1000;
const canDateAReading = (at: string) => {
  const instant = instantFromInput(at);
  return instant != null && instant.getTime() <= Date.now() + LATEST_READING_AHEAD_MS;
};

const MeasurementCreate = z.object({
  value: z.number().finite(),
  measured_at: z.string().datetime().refine(canDateAReading, "measured_at is when the reading was taken: a real date, not one still to come.").optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  note: blankIsNone(2000),
});

// AI-ACTION: tracking:log-measurement
metricsRouter.post(
  "/metrics/:id/measurements",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "tracking:log-measurement"))) return;
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
      userId: sessionUser(req)?.id ?? null,
      metric,
      value: parsed.data.value,
      note: parsed.data.note ?? null,
      measuredAt: instantFromInput(parsed.data.measured_at) ?? undefined,
    });
    res.status(201).json({ ...row, value: Number(row.value) });
  }),
);

// One reading, at the address its kind declares (getEndpoint
// "/measurements/{id}"); lint:declared-endpoints-served holds the pair.
metricsRouter.get(
  "/measurements/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const row = await tenantDb(req).selectFrom("tracking_measurements").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Measurement not found." } });
    res.json({ ...row, value: Number(row.value) });
  }),
);

// AI-ACTION: tracking:remove-measurement
metricsRouter.delete(
  "/measurements/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "tracking:remove-measurement"))) return;
    const removed = await removeMeasurement({
      db: tenantDb(req),
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      id: req.params.id!,
    });
    if (!removed) return void res.status(404).json({ error: { code: "not_found", message: "Measurement not found." } });
    res.status(204).end();
  }),
);
