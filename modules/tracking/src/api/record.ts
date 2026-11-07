// Shared measurement-recording path. Both the HTTP route
// (POST /metrics/:id/measurements) and the wire action
// (tracking:log-measurement) funnel through here so the goal-reached
// check + notification fire identically no matter how a value arrives.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { TrackingDB, MeasurementsTable } from "../db.js";
import type { Selectable } from "kysely";
import { valueWithUnit } from "@cobblr/platform-contract/money";

export interface MetricLike {
  id: string;
  name: string;
  unit: string | null;
  goal_value: string | null;
  goal_direction: string;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** Whether a metric of this name is there, whatever its case, leaving out the
 *  one being renamed. Holds the name until the transaction ends, so two people
 *  making one at once are told one after the other. Metrics that shared a name
 *  before this stay as they are. */
export async function metricOfName(trx: Kysely<TrackingDB>, name: string, exceptId?: string): Promise<{ id: string } | undefined> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tracking-metric-name:${name.toLowerCase()}`}, 0))`.execute(trx);
  let q = trx.selectFrom("tracking_metrics").select("id").where(sql<boolean>`lower(name) = lower(${name})`);
  if (exceptId) q = q.where("id", "!=", exceptId);
  return q.orderBy("created_at", "asc").orderBy("id", "asc").limit(1).executeTakeFirst();
}

/** A metric's name is taken: a person reading two "Weight"s cannot tell which is which. */
export class MetricNameTaken extends Error {}

/** Direction-aware: has `value` met `goal`? The bar in metrics.ts progress() is full on this same test. */
export function goalReached(value: number, goal: number, dir: string): boolean {
  if (dir === "down") return value <= goal;
  if (dir === "up") return value >= goal;
  // "hit": within a 2% band of the target
  return Math.abs(value - goal) <= Math.abs(goal) * 0.02;
}

/**
 * Insert one measurement, emit `measurement.logged`, and, if it crosses the
 * metric's goal, emit `goal.reached` AND dispatch an in-app notification to
 * every workspace member (so a hit goal is never silent). Crossing means the
 * newest reading now meets the goal and the one before it did not: a metric
 * that stays past its goal told everyone again at every reading, and a reading
 * dated last year crosses nothing today.
 */
export async function logMeasurement(opts: {
  db: Kysely<TrackingDB>;
  orgId: string;
  metric: MetricLike;
  value: number;
  note?: string | null;
  measuredAt?: Date;
  /** Who logged it, for the activity row; null for a wire or a system path. */
  userId?: string | null;
}): Promise<Selectable<MeasurementsTable>> {
  const { db, orgId, metric, value } = opts;
  const goal = num(metric.goal_value);
  const measuredAt = opts.measuredAt ?? new Date();
  let crossed = false;
  const row = await platform().activity.transaction(orgId, db, async (trx, log) => {
    if (goal != null && goalReached(value, goal, metric.goal_direction)) {
      const newest = await trx
        .selectFrom("tracking_measurements")
        .select(["value", "measured_at"])
        .where("metric_id", "=", metric.id)
        .orderBy("measured_at", "desc")
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      crossed = !newest || (new Date(newest.measured_at).getTime() <= measuredAt.getTime() && !goalReached(Number(newest.value), goal, metric.goal_direction));
    }
    const row = await trx
      .insertInto("tracking_measurements")
      .values({
        metric_id: metric.id,
        value: String(value),
        measured_at: measuredAt,
        note: opts.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await log({
      orgId,
      userId: opts.userId ?? null,
      action: "measurement_created",
      ref: { module: "tracking", entityType: "measurement", entityId: row.id },
      diff: { name: metric.name, value, metric_id: metric.id },
    });
    return row;
  });
  void platform().events.emit("tracking.measurement.logged", { orgId, metricId: metric.id, value });

  if (goal != null && crossed) {
    void platform().events.emit("tracking.goal.reached", { orgId, metricId: metric.id, value, goal });
    try {
      const memberIds = await platform().notifications.orgMemberIds(orgId);
      const recordLink = await platform().entities.recordAddressForEntity(
        orgId,
        "tracking:metric",
        metric.id,
      );
      for (const userId of memberIds) {
        await platform().notifications.dispatch({
          orgId,
          userId,
          eventType: "tracking.goal-reached",
          message: `🎯 Goal reached: ${metric.name} hit ${valueWithUnit(goal, metric.unit)}`,
          // Straight to the metric, opened. It said "you hit your goal" and
          // then went nowhere, so the only way to see the number behind it was
          // to remember where the metric lived.
          ...(recordLink
            ? { link_url: recordLink }
            : { no_link_reason: "the metric has no detail page" }),
          module: "tracking",
          entityType: "tracking:metric",
          entityId: metric.id,
          payload: { value, goal },
        });
      }
    } catch (err) {
      console.error("[tracking] goal-reached notify failed:", (err as Error).message);
    }
  }
  return row;
}

/** Take one reading off, on the record, as logging it was. False when it is not there. */
export async function removeMeasurement(opts: { db: Kysely<TrackingDB>; orgId: string; id: string; userId?: string | null }): Promise<boolean> {
  const { db, orgId, id } = opts;
  return platform().activity.transaction(orgId, db, async (trx, log) => {
    const row = await trx.deleteFrom("tracking_measurements").where("id", "=", id).returning(["id", "metric_id", "value"]).executeTakeFirst();
    if (!row) return false;
    const metric = await trx.selectFrom("tracking_metrics").select(["name"]).where("id", "=", row.metric_id).executeTakeFirst();
    await log({
      orgId,
      userId: opts.userId ?? null,
      action: "measurement_deleted",
      ref: { module: "tracking", entityType: "measurement", entityId: row.id },
      diff: { name: metric?.name ?? null, value: Number(row.value), metric_id: row.metric_id },
    });
    return true;
  });
}
