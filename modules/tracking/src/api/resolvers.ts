// Entity resolvers for tracking — lets core-views/search read metrics +
// measurements. The measurement list resolver (filterable by metric_id) is
// what the trend-chart view renderer consumes.

import { type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { TrackingDB } from "../db.js";

let registered = false;

export function registerTrackingResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("tracking:metric", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<TrackingDB>;
    const row = await db.selectFrom("tracking_metrics").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? metricToResolved(row) : null;
  });

  platform().entities.registerListResolver("tracking:metric", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<TrackingDB>;
    const rows = await db
      .selectFrom("tracking_metrics")
      .selectAll()
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .orderBy("created_at", "desc")
      .execute();
    return { items: rows.map(metricToResolved) };
  });

  platform().entities.registerResolver("tracking:measurement", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<TrackingDB>;
    const row = await db.selectFrom("tracking_measurements").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? measurementToResolved(row) : null;
  });

  platform().entities.registerListResolver("tracking:measurement", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<TrackingDB>;
    let q = db.selectFrom("tracking_measurements").selectAll();
    const metricId = query.filter?.metric_id;
    if (typeof metricId === "string") q = q.where("metric_id", "=", metricId);
    const rows = await q.limit(Math.min(query.limit ?? 500, 2000)).offset(query.offset ?? 0).orderBy("measured_at", "asc").execute();
    return { items: rows.map(measurementToResolved) };
  });
}

function metricToResolved(row: { id: string; name: string; unit: string | null; goal_value: string | null; goal_direction: string }): ResolvedEntity {
  return {
    kind: "tracking:metric",
    id: row.id,
    title: row.name,
    subtitle: row.unit ?? undefined,
    detailUrl: `/tracking/${row.id}`,
    fields: { name: row.name, unit: row.unit, goal_value: row.goal_value == null ? null : Number(row.goal_value), goal_direction: row.goal_direction },
  };
}

function measurementToResolved(row: { id: string; metric_id: string; value: string; measured_at: Date; note: string | null }): ResolvedEntity {
  return {
    kind: "tracking:measurement",
    id: row.id,
    title: String(Number(row.value)),
    subtitle: row.note ?? undefined,
    fields: { metric_id: row.metric_id, value: Number(row.value), measured_at: row.measured_at, note: row.note },
  };
}
