// One-shot heal: put a readable name, and a goal that can be met, on metrics saved without.
//
// DONE WHEN: no tracking_metrics row made before `since` is changed by repairedMetric. Check prod, staging and dev,
// then delete this file and its onBoot call.
//
// BORN WITH: metrics.ts refuses a name with nothing to read and an infinite goal, and action-handlers.ts refuses the
// same name when a wire makes a metric by name, so a metric made now is already right.
//
// WHY IT EXISTS: the API and a wire could save a metric named with only spaces, or across two lines, which drew a card
// with nothing to press, and a goal of Infinity, which read back as no goal and was reached by every lower-is-better
// reading.

import { canBeAName } from "@cobblr/platform-contract/readable-text";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { TrackingDB } from "./db.js";

interface MetricRow { name: string; unit: string | null; goal_value: string | null }

/** What has to change on this metric, or null when nothing does. */
export function repairedMetric(row: MetricRow): Partial<MetricRow> | null {
  const patch: Partial<MetricRow> = {};
  const oneLine = row.name.replace(/\p{Cc}+/gu, " ").trim();
  const name = canBeAName(oneLine) ? oneLine : "Unnamed metric";
  if (name !== row.name) patch.name = name;
  if (row.unit != null && !row.unit.trim()) patch.unit = null;
  if (row.goal_value != null && !Number.isFinite(Number(row.goal_value))) patch.goal_value = null;
  return Object.keys(patch).length > 0 ? patch : null;
}

export async function healUnreadableMetrics(db: Kysely<TrackingDB>, since: Date): Promise<number> {
  let healed = 0;
  const rows = await db.selectFrom("tracking_metrics").select(["id", "name", "unit", "goal_value"]).where("created_at", "<", since).execute();
  for (const row of rows) {
    const patch = repairedMetric(row);
    if (!patch) continue;
    await db.updateTable("tracking_metrics").set(patch).where("id", "=", row.id).execute();
    healed++;
  }
  return healed;
}

export function registerUnreadableMetricsHeal(): void {
  registerHealPass({
    name: "tracking.unreadable-metrics",
    since: "2026-11-06T13:00:00Z",
    shim: "modules/tracking/src/heal-unreadable-metrics.ts",
    module: "tracking",
    visit: ({ db, since }) => healUnreadableMetrics(db as Kysely<TrackingDB>, since),
  });
}
