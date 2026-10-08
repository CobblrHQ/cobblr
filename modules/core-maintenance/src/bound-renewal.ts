import { RenewalBindingSchema, type RenewalFieldBinding } from "@cobblr/platform-contract/record-creation";
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import { createSchedule } from "./api/schedules.js";
import { cancellationReminder } from "./schedule.js";
import type { ScheduleRow } from "./schedules-store.js";
import { MaintenanceRefusal } from "./refusal.js";

export const RenewalFields = RenewalBindingSchema;
export type { RenewalFieldBinding };

export async function boundRenewalValues(orgId: string, kind: string, id: string, binding: RenewalFieldBinding) {
  const row = await platform().entities.snapshot(orgId, kind, id);
  const values = { ...row, ...((row?.metadata ?? {}) as Record<string, unknown>) };
  const expiry = values[binding.expiry];
  const cycle = values[binding.cycle];
  const months = Number(values[binding.custom_months] ?? 1);
  const notice = Number(values[binding.notice_days] ?? 0);
  if (!Number.isInteger(notice) || notice < 0 || notice > 3650) throw new MaintenanceRefusal("Notice period must be 0 to 3650 days");
  if (cycle === "Custom" && (!Number.isInteger(months) || months < 1 || months > 1000)) throw new MaintenanceRefusal("Custom billing must be 1 to 1000 months");
  const auto = values[binding.auto_renews] === true || values[binding.auto_renews] === "true";
  return { values, current_expiry: typeof expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null,
    every_n: cycle === "Custom" ? months : cycle === "Quarterly" ? 3 : 1,
    every_unit: (cycle === "Weekly" ? "week" : cycle === "Monthly" || cycle === "Custom" || cycle === "Quarterly" ? "month" : "year") as "week" | "month" | "year",
    cancel_notice_days: auto ? notice : null, remind: auto ? cancellationReminder(notice) : { before: 7, unit: "day" as const } };
}

export async function refreshBoundRenewal(db: Kysely<CoreMaintenanceDB>, orgId: string, s: ScheduleRow): Promise<ScheduleRow> {
  if (!s.renewal_fields || s.ended_at) return s;
  const v = await boundRenewalValues(orgId, `${s.entity_module}:${s.entity_type}`, s.entity_id, s.renewal_fields);
  if (s.every_n === v.every_n && s.every_unit === v.every_unit && s.cancel_notice_days === v.cancel_notice_days && JSON.stringify(s.remind) === JSON.stringify(v.remind)) return s;
  return db.updateTable("core_maintenance_schedules").set({ every_n: v.every_n, every_unit: v.every_unit, cancel_notice_days: v.cancel_notice_days, remind: JSON.stringify(v.remind) as never, updated_at: new Date() }).where("id", "=", s.id).returningAll().executeTakeFirstOrThrow();
}

export async function ensureBoundRenewal(db: Kysely<CoreMaintenanceDB>, orgId: string, kind: string, id: string, binding: RenewalFieldBinding) {
  const defs = await platform().entities.fieldsFor(orgId, kind);
  for (const key of Object.values(binding)) if (!defs.some(d => d.name === key)) throw new MaintenanceRefusal("Choose fields on this collection");
  const v = await boundRenewalValues(orgId, kind, id, binding);
  if (!v.current_expiry) return { schedule_id: null };
  const expiry = v.current_expiry;
  const [entity_module, entity_type] = kind.split(":");
  return db.transaction().execute(async tx => {
    await sql`select pg_advisory_xact_lock(hashtext(${`bound-renewal:${id}:${binding.expiry}`}))`.execute(tx);
    let s = await tx.selectFrom("core_maintenance_schedules").selectAll().where("entity_id", "=", id).where("expiry_field", "=", binding.expiry).executeTakeFirst();
    if (!s) s = await createSchedule(tx, orgId, { entity_module: entity_module!, entity_type: entity_type!, entity_id: id, name: "Renewal", anchor: expiry.slice(5), current_expiry: expiry, expiry_field: binding.expiry, every_n: v.every_n, every_unit: v.every_unit, remind: v.remind });
    if (s.ended_at) return { schedule_id: s.id };
    s = await tx.updateTable("core_maintenance_schedules").set({ renewal_fields: JSON.stringify(binding) as never }).where("id", "=", s.id).returningAll().executeTakeFirstOrThrow();
    await refreshBoundRenewal(tx, orgId, s);
    return { schedule_id: s.id };
  });
}
