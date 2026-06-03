// Shared measurement-recording path. Both the HTTP route
// (POST /metrics/:id/measurements) and the wire action
// (tracking:log-measurement) funnel through here so the goal-reached
// check + notification fire identically no matter how a value arrives.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { TrackingDB, MeasurementsTable } from "../db.js";
import type { Selectable } from "kysely";

export interface MetricLike {
  id: string;
  name: string;
  unit: string | null;
  goal_value: string | null;
  goal_direction: string;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** Direction-aware: has `value` met `goal`? Mirrors metrics.ts progress(). */
export function goalReached(value: number, goal: number, dir: string): boolean {
  if (dir === "down") return value <= goal;
  if (dir === "up") return value >= goal;
  // "hit": within a 2% band of the target
  return Math.abs(value - goal) <= Math.abs(goal) * 0.02;
}

/**
 * Insert one measurement, emit `measurement.logged`, and — if it meets the
 * metric's goal — emit `goal.reached` AND dispatch an in-app notification to
 * every workspace member (so a hit goal is never silent).
 */
export async function logMeasurement(opts: {
  db: Kysely<TrackingDB>;
  orgId: string;
  metric: MetricLike;
  value: number;
  note?: string | null;
  measuredAt?: Date;
}): Promise<Selectable<MeasurementsTable>> {
  const { db, orgId, metric, value } = opts;
  const row = await db
    .insertInto("tracking_measurements")
    .values({
      metric_id: metric.id,
      value: String(value),
      measured_at: opts.measuredAt ?? new Date(),
      note: opts.note ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  void platform().events.emit("tracking.measurement.logged", { orgId, metricId: metric.id, value });

  const goal = num(metric.goal_value);
  if (goal != null && goalReached(value, goal, metric.goal_direction)) {
    void platform().events.emit("tracking.goal.reached", { orgId, metricId: metric.id, value, goal });
    try {
      const unit = metric.unit ? ` ${metric.unit}` : "";
      const memberIds = await platform().notifications.orgMemberIds(orgId);
      for (const userId of memberIds) {
        await platform().notifications.dispatch({
          orgId,
          userId,
          eventType: "tracking.goal-reached",
          message: `🎯 Goal reached — ${metric.name} hit ${goal}${unit}`,
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
