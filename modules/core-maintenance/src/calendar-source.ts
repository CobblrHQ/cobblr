// Calendar source: scheduled, not-yet-done maintenance entries become
// all-day events on the workspace calendar (car oil change, filter swap,
// registration renewal). Registered at boot; the kernel calls it for the
// requested window. core-maintenance never imports core-calendar — it just
// contributes through the platform seam.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CalendarEvent } from "@cobblr/platform-contract";

interface DueRow {
  id: string;
  name: string;
  scheduled_at: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
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
      const compiled = sql<DueRow>`
        select id, name, scheduled_at, entity_module, entity_type, entity_id
        from core_maintenance_entries
        where scheduled_at is not null
          and performed_at is null
          and scheduled_at::date >= ${fromISO}::date
          and scheduled_at::date <= ${toISO}::date
        order by scheduled_at asc
      `.compile(tdb);
      const { rows } = (await tdb.executeQuery(compiled)) as { rows: DueRow[] };
      return rows.map<CalendarEvent>((r) => ({
        id: `maintenance:${r.id}`,
        title: r.name,
        date: new Date(r.scheduled_at).toISOString().slice(0, 10),
        allDay: true,
        source: "maintenance",
        category: "maintenance",
        entityModule: r.entity_module,
        entityType: r.entity_type,
        entityId: r.entity_id,
      }));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("does not exist")) return [];
      throw err;
    }
  });
}
