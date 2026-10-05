// Calendar source: scheduled, not-yet-done maintenance entries become
// all-day events on the workspace calendar (car oil change, filter swap,
// registration renewal). Registered at boot; the kernel calls it for the
// requested window. core-maintenance never imports core-calendar — it just
// contributes through the platform seam.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { reconcileSchedules } from "./schedules-store.js";
import { reminderAt, type Reminder } from "./schedule.js";
import type { CoreMaintenanceDB } from "./db.js";
import type { CalendarEvent } from "@cobblr/platform-contract";

interface DueRow {
  id: string;
  name: string;
  scheduled_at: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  remind: Reminder | null;
  nag_stopped_at: Date | null;
  nag_snoozed_until: Date | null;
  schedule_id: string | null;
}

export function registerMaintenanceCalendarSource(): void {
  platform().calendar.registerSource("maintenance", async (orgId, fromISO, toISO) => {
    let tdb: Kysely<unknown>;
    try {
      tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    } catch {
      return [];
    }
    try {
      await reconcileSchedules(tdb as Kysely<CoreMaintenanceDB>, orgId);
      const compiled = sql<DueRow>`
        select e.id, e.name, e.scheduled_at, e.entity_module, e.entity_type, e.entity_id, e.schedule_id, s.remind, e.nag_stopped_at, e.nag_snoozed_until
        from core_maintenance_entries e
        left join core_maintenance_schedules s on s.id = e.schedule_id
        where e.scheduled_at is not null
          and e.performed_at is null
          and e.scheduled_at::date >= ${fromISO}::date
        order by e.scheduled_at asc
      `.compile(tdb);
      const { rows } = (await tdb.executeQuery(compiled)) as { rows: DueRow[] };
      return rows.flatMap<CalendarEvent>((r) => {
        const due = new Date(r.scheduled_at).toISOString().slice(0, 10);
        const reminder = reminderAt(new Date(r.scheduled_at), r.remind).toISOString().slice(0, 10);
        const event: CalendarEvent = {
        id: `maintenance:${r.id}`,
        title: r.name + (r.nag_stopped_at ? " (reminders off)" : r.nag_snoozed_until && new Date(r.nag_snoozed_until) > new Date() ? " (reminders snoozed)" : ""),
        date: new Date(r.scheduled_at).toISOString().slice(0, 10),
        allDay: true,
        source: "maintenance",
        category: "maintenance",
        entityModule: r.entity_module,
        entityType: r.entity_type,
        entityId: r.entity_id,
      };
        return [ ...(due <= toISO ? [event] : []), ...(r.schedule_id && reminder >= fromISO && reminder <= toISO && reminder !== due ? [{ ...event, id: `maintenance-reminder:${r.id}`, title: `Reminder: ${r.name}`, date: reminder }] : []) ];
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("does not exist")) return [];
      throw err;
    }
  });
}
