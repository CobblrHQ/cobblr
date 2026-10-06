import { sql, type Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import { createSchedule } from "./api/schedules.js";
import { ensureOccurrence } from "./schedules-store.js";

export async function ensureUsageSchedule(db: Kysely<CoreMaintenanceDB>, orgId: string, input: { entity_module: string; entity_type: string; entity_id: string; name: string; counter_field: string; counter_every: number }) {
  return db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(hashtext(${`usage-schedule:${input.entity_id}:${input.counter_field}`}))`.execute(trx);
    let row = await trx.selectFrom("core_maintenance_schedules").selectAll().where("entity_id", "=", input.entity_id).where("counter_field", "=", input.counter_field).orderBy("created_at").executeTakeFirst();
    if (!row) {
      row = await createSchedule(trx, orgId, input);
      row = await trx.updateTable("core_maintenance_schedules").set({ last_done_counter: "0" }).where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
    } else if (row.name !== input.name || Number(row.counter_every) !== input.counter_every) {
      row = await trx.updateTable("core_maintenance_schedules").set({ name: input.name, counter_every: String(input.counter_every), updated_at: new Date() }).where("id", "=", row.id).returningAll().executeTakeFirstOrThrow();
    }
    const occurrence = await ensureOccurrence(trx, orgId, row);
    return { schedule_id: row.id, occurrence_id: occurrence?.id ?? null };
  });
}
