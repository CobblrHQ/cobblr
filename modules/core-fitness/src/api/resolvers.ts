// Entity resolvers for core-fitness — lets core-views/search read metrics +
// measurements. The measurement list resolver (filterable by metric_id) is
// what the trend-chart view renderer consumes.

import { type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { CoreFitnessDB } from "../db.js";

let registered = false;

export function registerFitnessResolvers(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerResolver("core-fitness:metric", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFitnessDB>;
    const row = await db.selectFrom("core_fitness_metrics").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? metricToResolved(row) : null;
  });

  platform().entities.registerListResolver("core-fitness:metric", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFitnessDB>;
    const rows = await db
      .selectFrom("core_fitness_metrics")
      .selectAll()
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .orderBy("created_at", "desc")
      .execute();
    return { items: rows.map(metricToResolved) };
  });

  platform().entities.registerResolver("core-fitness:measurement", async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFitnessDB>;
    const row = await db.selectFrom("core_fitness_measurements").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? measurementToResolved(row) : null;
  });

  platform().entities.registerListResolver("core-fitness:measurement", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFitnessDB>;
    let q = db.selectFrom("core_fitness_measurements").selectAll();
    const metricId = query.filter?.metric_id;
    if (typeof metricId === "string") q = q.where("metric_id", "=", metricId);
    const rows = await q.limit(Math.min(query.limit ?? 500, 2000)).offset(query.offset ?? 0).orderBy("measured_at", "asc").execute();
    return { items: rows.map(measurementToResolved) };
  });
}

function metricToResolved(row: { id: string; name: string; unit: string | null; goal_value: string | null; goal_direction: string }): ResolvedEntity {
  return {
    kind: "core-fitness:metric",
    id: row.id,
    title: row.name,
    subtitle: row.unit ?? undefined,
    detailUrl: `/tracking/${row.id}`,
    fields: { name: row.name, unit: row.unit, goal_value: row.goal_value == null ? null : Number(row.goal_value), goal_direction: row.goal_direction },
  };
}

function measurementToResolved(row: { id: string; metric_id: string; value: string; measured_at: Date; note: string | null }): ResolvedEntity {
  return {
    kind: "core-fitness:measurement",
    id: row.id,
    title: String(Number(row.value)),
    subtitle: row.note ?? undefined,
    fields: { metric_id: row.metric_id, value: Number(row.value), measured_at: row.measured_at, note: row.note },
  };
}
