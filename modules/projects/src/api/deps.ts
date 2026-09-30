// What "blocked" means, in one place. A dependency on another task is open
// while that task is not done or cancelled: read from the blocker itself, so
// completing it by any door (the task page, a wire, the assistant, the generic
// record edit) unblocks, and reopening it blocks again. A dependency on any
// other record is open until something marks it satisfied (the
// set-dep-satisfied wire). The `satisfied` column therefore only ever speaks
// for record dependencies.

import { sql, type Kysely, type RawBuilder } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";

const CLOSED = ["done", "cancelled"] as const;

/** The number of open blockers of the task whose id is the SQL expression
 *  `taskIdRef` (e.g. `t.id`). */
export function openBlockerCount(taskIdRef: string): RawBuilder<string> {
  return sql<string>`(
    select count(*) from projects_task_dependencies d
    left join projects_tasks b on b.id = d.depends_on_task_id
    where d.task_id = ${sql.ref(taskIdRef)}
      and (
        (d.depends_on_task_id is null and d.satisfied = false)
        or (d.depends_on_task_id is not null and b.id is not null and b.status not in (${sql.join(CLOSED.map((s) => sql.lit(s)))}))
      )
  )`;
}

/** Each dependency of one task, with whether it still holds the task up. */
export async function dependenciesOf(db: Kysely<ProjectsDB>, taskId: string) {
  const rows = await db
    .selectFrom("projects_task_dependencies as d")
    .leftJoin("projects_tasks as b", "b.id", "d.depends_on_task_id")
    .selectAll("d")
    .select(["b.title as blocker_title", "b.status as blocker_status"])
    .where("d.task_id", "=", taskId)
    .orderBy("d.created_at")
    .execute();
  return rows.map((r) => ({
    ...r,
    open: r.depends_on_task_id
      ? r.blocker_status !== null && !(CLOSED as readonly string[]).includes(r.blocker_status)
      : !r.satisfied,
  }));
}

/** After blockers changed, announce every task among `taskIds` that no longer
 *  has an open one. Once per task, not once per dependency: a task waiting on
 *  two things is not unblocked by the first. */
export async function announceUnblocked(
  orgId: string,
  db: Kysely<ProjectsDB>,
  taskIds: readonly string[],
  via: { kind: string; id: string },
): Promise<string[]> {
  if (taskIds.length === 0) return [];
  const rows = await db
    .selectFrom("projects_tasks as t")
    .select(["t.id", openBlockerCount("t.id").as("open")])
    .where("t.id", "in", [...new Set(taskIds)])
    .where("t.status", "not in", [...CLOSED])
    .execute();
  const freed = rows.filter((r) => Number(r.open) === 0).map((r) => r.id);
  for (const taskId of freed) platform().events.emit("projects.task.unblocked", { orgId, taskId, via });
  return freed;
}

/** A task was completed or cancelled: the tasks that waited on it may be free. */
export async function releaseDependentsOf(orgId: string, db: Kysely<ProjectsDB>, blockerId: string): Promise<string[]> {
  const waiting = await db
    .selectFrom("projects_task_dependencies")
    .select("task_id")
    .where("depends_on_task_id", "=", blockerId)
    .execute();
  return announceUnblocked(orgId, db, waiting.map((w) => w.task_id), { kind: "projects:task", id: blockerId });
}

/** Why a new "task waits on task" dependency cannot be recorded, or null when
 *  it can. Both doors (the route and the assistant's action) ask this, so a
 *  loop cannot be made through one that the other refuses: a loop is two tasks
 *  each waiting on the other, and neither can ever start. */
export async function refuseNewTaskDependency(
  db: Kysely<ProjectsDB>,
  taskId: string,
  dependsOnId: string,
): Promise<string | null> {
  if (taskId === dependsOnId) return "A task can't wait on itself.";
  const both = await db.selectFrom("projects_tasks").select("id").where("id", "in", [taskId, dependsOnId]).execute();
  if (!both.some((t) => t.id === taskId)) return `There is no task with id ${taskId}.`;
  if (!both.some((t) => t.id === dependsOnId)) return `There is no task with id ${dependsOnId}.`;
  // Does dependsOn already wait, directly or through others, on taskId?
  const reach = await sql<{ id: string }>`
    with recursive up(id) as (
      select depends_on_task_id from projects_task_dependencies where task_id = ${dependsOnId} and depends_on_task_id is not null
      union
      select d.depends_on_task_id from projects_task_dependencies d join up on d.task_id = up.id where d.depends_on_task_id is not null
    )
    select id from up where id = ${taskId} limit 1`.execute(db);
  if (reach.rows.length > 0) return "That would make a loop: the other task already waits on this one, so neither could ever start.";
  const dup = await db
    .selectFrom("projects_task_dependencies")
    .select("id")
    .where("task_id", "=", taskId)
    .where("depends_on_task_id", "=", dependsOnId)
    .executeTakeFirst();
  if (dup) return "This task already waits on that one.";
  return null;
}
