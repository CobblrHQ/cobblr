// Calendar source: open tasks with a due date become all-day events on
// the workspace calendar. Done / cancelled tasks are excluded — the
// calendar shows what's still ahead of you.

import { dayStoredAt } from "@cobblr/platform-contract/day";
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
        date: dayStoredAt(r.due_date, "UTC")!,
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
  }, { module: "projects" });
}

interface LateTaskRow {
  id: string;
  title: string;
  due_date: string;
  assignee: string | null;
}

/** Overdue source: open tasks due today or earlier, with who has each. A done
 *  or cancelled task has nothing left to be late for, so marking one done is
 *  what stops the next step of the overdue sweep. */
export function registerProjectsOverdueSource(): void {
  platform().calendar.registerOverdueSource({
    kind: "projects:task",
    read: async (orgId, today) => {
      const tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
      const compiled = sql<LateTaskRow>`
        select id::text as id, title, due_date::text as due_date, metadata->>'assignee' as assignee
        from projects_tasks
        where due_date is not null
          and status not in ('done', 'cancelled')
          and due_date::date <= ${today}::date
      `.compile(tdb);
      let rows: LateTaskRow[];
      try {
        rows = ((await tdb.executeQuery(compiled)) as { rows: LateTaskRow[] }).rows;
      } catch (err) {
        if ((err as Error).message.includes("does not exist")) return [];
        throw err;
      }
      return rows.flatMap((r) => {
        const dueOn = dayStoredAt(r.due_date, "UTC");
        return dueOn ? [{ kind: "projects:task", id: r.id, name: r.title, dueOn, assigneePersonId: r.assignee || null }] : [];
      });
    },
  });
}
