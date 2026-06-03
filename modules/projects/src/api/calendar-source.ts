// Calendar source: open tasks with a due date become all-day events on
// the workspace calendar. Done / cancelled tasks are excluded — the
// calendar shows what's still ahead of you.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CalendarEvent } from "@cobblr/platform-contract";

interface DueTaskRow {
  id: string;
  title: string;
  due_date: string;
}

export function registerProjectsCalendarSource(): void {
  platform().calendar.registerSource("task", async (orgId, fromISO, toISO) => {
    let tdb: Kysely<unknown>;
    try {
      tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    } catch {
      return [];
    }
    try {
      const compiled = sql<DueTaskRow>`
        select id, title, due_date
        from projects_tasks
        where due_date is not null
          and status not in ('done', 'cancelled')
          and due_date::date >= ${fromISO}::date
          and due_date::date <= ${toISO}::date
        order by due_date asc
      `.compile(tdb);
      const { rows } = (await tdb.executeQuery(compiled)) as { rows: DueTaskRow[] };
      return rows.map<CalendarEvent>((r) => ({
        id: `task:${r.id}`,
        title: r.title,
        date: new Date(r.due_date).toISOString().slice(0, 10),
        allDay: true,
        source: "task",
        category: "task",
        entityModule: "projects",
        entityType: "task",
        entityId: r.id,
      }));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("does not exist")) return [];
      throw err;
    }
  });
}
