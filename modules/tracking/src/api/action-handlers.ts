// tracking action handlers. `tracking:log-measurement` is the wire
// target that lets ANY event feed a metric — the piece that turns the
// log/goal/trend primitive into something other modules can drive. With it, a
// bundle can wire e.g. `purchases.order_item.received → log a "Grocery spend"
// measurement` without tracking ever knowing purchases exists.
//
// The metric is resolved by id or by name (created on miss, like
// lists:add-item creates a list on miss). The value is resolved, in order,
// from: an explicit `value` arg → a named event-payload key (`valueKey`) →
// the rendered wire template. Whatever arrives funnels through logMeasurement()
// so the goal-reached check + notification are identical to the HTTP path.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { TrackingDB } from "../db.js";
import { logMeasurement, type MetricLike } from "./record.js";

let registered = false;

interface LogArgs {
  /** Target metric — by id (preferred) or by exact name (created if missing). */
  metricId?: string;
  metricName?: string;
  /** On create-by-name, seed the metric's goal/unit. */
  unit?: string;
  goalValue?: number;
  goalDirection?: "up" | "down" | "hit";
  /** Value sources, highest priority first. */
  value?: number;
  valueKey?: string; // read this key off the triggering event payload
  note?: string;
}

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n) && v.trim() !== "") return n;
  }
  return undefined;
}

export function registerTrackingActionHandlers(): void {
  registerUndos();
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("tracking.log-measurement", async (ctx) => {
    const args = (ctx.args as LogArgs | null) ?? {};
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<TrackingDB>;

    // 1. Resolve the numeric value: explicit arg → named event key → template.
    let value = coerceNumber(args.value);
    if (value === undefined && args.valueKey) {
      const payload = (ctx.event?.payload as Record<string, unknown> | undefined) ?? {};
      value = coerceNumber(payload[args.valueKey]);
    }
    if (value === undefined && ctx.rendered != null) value = coerceNumber(ctx.rendered);
    if (value === undefined) return ctx.event?.trigger_type && ctx.event.trigger_type !== "user-invoked" ? { ok: true, skipped: "no numeric value (set value / valueKey / template)" } : { ok: false, error: "what number? pass `value` (the reading to log)" };

    // 2. Resolve the metric — the record this runs ON, else by id, else by
    //    name (create-on-miss). Asked on a metric ("record 15 for today"),
    //    the metric is the record; without this the handler skipped with
    //    "need metricId or metricName" on the page that named it (#3378).
    let metric: MetricLike | undefined;
    const onMetric = ctx.entity?.kind === "tracking:metric" ? ctx.entity.id : "";
    if (onMetric) {
      metric = await db
        .selectFrom("tracking_metrics")
        .select(["id", "name", "unit", "goal_value", "goal_direction"])
        .where("id", "=", onMetric)
        .executeTakeFirst();
    }
    if (!metric && args.metricId) {
      metric = await db
        .selectFrom("tracking_metrics")
        .select(["id", "name", "unit", "goal_value", "goal_direction"])
        .where("id", "=", args.metricId)
        .executeTakeFirst();
    }
    if (!metric && args.metricName) {
      const name = args.metricName.trim();
      metric = await db
        .selectFrom("tracking_metrics")
        .select(["id", "name", "unit", "goal_value", "goal_direction"])
        .where(sql<boolean>`lower(name) = lower(${name})`)
        .executeTakeFirst();
      if (!metric) {
        metric = await db
          .insertInto("tracking_metrics")
          .values({
            name,
            unit: args.unit ?? null,
            goal_value: args.goalValue != null ? String(args.goalValue) : null,
            goal_direction: args.goalDirection ?? "hit",
            metadata: sql`'{}'::jsonb` as never,
          })
          .returning(["id", "name", "unit", "goal_value", "goal_direction"])
          .executeTakeFirstOrThrow();
        void platform().events.emit("tracking.metric.created", { orgId: ctx.orgId, metricId: metric.id });
        await platform().activity.log({
          orgId: ctx.orgId,
          userId: ctx.userId ?? null,
          action: "metric_created",
          ref: { module: "tracking", entityType: "metric", entityId: metric.id },
          diff: { name: metric.name },
        });
      }
    }
    if (!metric) return { ok: false, error: "which metric? run this on the metric, or name it in `metricName`" };

    const row = await logMeasurement({ db, orgId: ctx.orgId, userId: ctx.userId ?? null, metric, value, note: args.note ?? null });
    return {
      ok: true,
      metricId: metric.id,
      value,
      measurementId: row.id,
      summary: `${value}${metric.unit ? ` ${metric.unit}` : ""} logged on "${metric.name}"`,
    };
  });
}

function registerUndos(): void {
  platform().actions.registerHandler("tracking.remove-measurement", async (ctx) => {
    const id = String((ctx.args as { measurement_id?: unknown } | null)?.measurement_id ?? "").trim();
    if (!id) return { ok: false, error: "missing measurement_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<TrackingDB>;
    const row = await db.deleteFrom("tracking_measurements").where("id", "=", id).returning(["id"]).executeTakeFirst();
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: "Removed the measurement.", removed: row.id };
  });
  platform().actions.registerUndo("tracking.log-measurement", (result) => {
    const r = result as { ok?: unknown; skipped?: unknown; measurementId?: unknown } | null;
    if (r?.ok !== true || r.skipped || typeof r.measurementId !== "string") return null;
    return { action_id: "tracking:remove-measurement", args: { measurement_id: r.measurementId } };
  });
}
