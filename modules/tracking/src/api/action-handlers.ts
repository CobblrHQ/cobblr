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
import { canBeAName } from "@cobblr/platform-contract/readable-text";
import { logMeasurement, removeMeasurement, type MetricLike } from "./record.js";

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

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
// A sign, a short currency mark, one number with its thousands, and a unit with no digit in it.
const NUMBER_IN_WORDS = /^(-?)\s*[^\d\s.,+-]{0,3}\s*(-?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\D*$/;

/** The number a value says, or undefined when it does not say exactly one:
 *  stripping everything else logged "no reading today" as 0 and "12 of 15" as 1215. */
export function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  if (PLAIN_NUMBER.test(text)) {
    const plain = Number(text);
    return Number.isFinite(plain) ? plain : undefined;
  }
  const match = NUMBER_IN_WORDS.exec(text);
  if (!match) return undefined;
  const n = Number(match[3]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return match[1] || match[2] ? -n : n;
}

const GOAL_DIRECTIONS = new Set(["up", "down", "hit"]);
const textOr = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

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
    const name = typeof args.metricName === "string" ? args.metricName.trim() : "";
    if (!metric && name && (name.length > 200 || !canBeAName(name))) {
      return { ok: false, error: "a metric's name needs something to read, on one line, in 200 characters or fewer" };
    }
    if (!metric && name) {
      // The oldest of any that share the name, so a wire feeds one metric, not whichever the database hands back.
      metric = await db
        .selectFrom("tracking_metrics")
        .select(["id", "name", "unit", "goal_value", "goal_direction"])
        .where(sql<boolean>`lower(name) = lower(${name})`)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst();
      if (!metric) {
        const goalValue = coerceNumber(args.goalValue);
        metric = await platform().activity.transaction(ctx.orgId, db, async (trx, log) => {
          const made = await trx
            .insertInto("tracking_metrics")
            .values({
              name,
              unit: textOr(args.unit, 40),
              goal_value: goalValue != null ? String(goalValue) : null,
              goal_direction: GOAL_DIRECTIONS.has(args.goalDirection ?? "") ? args.goalDirection! : "hit",
              metadata: sql`'{}'::jsonb` as never,
            })
            .returning(["id", "name", "unit", "goal_value", "goal_direction"])
            .executeTakeFirstOrThrow();
          await log({
            orgId: ctx.orgId,
            userId: ctx.userId ?? null,
            action: "metric_created",
            ref: { module: "tracking", entityType: "metric", entityId: made.id },
            diff: { name: made.name },
          });
          return made;
        });
        void platform().events.emit("tracking.metric.created", { orgId: ctx.orgId, metricId: metric.id });
      }
    }
    if (!metric) return { ok: false, error: "which metric? run this on the metric, or name it in `metricName`" };

    const row = await logMeasurement({ db, orgId: ctx.orgId, userId: ctx.userId ?? null, metric, value, note: textOr(args.note, 2000) });
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
    const removed = await removeMeasurement({ db, orgId: ctx.orgId, userId: ctx.userId ?? null, id });
    if (!removed) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: "Removed the measurement.", removed: id };
  });
  platform().actions.registerUndo("tracking.log-measurement", (result) => {
    const r = result as { ok?: unknown; skipped?: unknown; measurementId?: unknown } | null;
    if (r?.ok !== true || r.skipped || typeof r.measurementId !== "string") return null;
    return { action_id: "tracking:remove-measurement", args: { measurement_id: r.measurementId } };
  });
}
