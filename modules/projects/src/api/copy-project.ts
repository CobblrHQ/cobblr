// Do it again: a new project with another one's tasks. A shop's jobs repeat
// (print, sand, paint, pack), so the steps, their machines and who has each
// come across in the same order, each waiting on what it waited on before.
// What happened on the original (notes, photos, progress, parts used, its
// order's link) stays with it. Of the people given a copied task, only those
// whose task can start now are told; the rest hear it is their turn when the
// task before theirs is done.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { ProjectsDB } from "../db.js";
import { assigneeOf, tellAssignee } from "./assignee.js";

export async function copyProject(
  db: Kysely<ProjectsDB>,
  orgId: string,
  userId: string | null,
  sourceId: string,
  name: string,
  instance?: string,
) {
  const made = await db.transaction().execute(async (trx) => {
    let q = trx.selectFrom("projects_projects").selectAll().where("id", "=", sourceId);
    if (instance) q = q.where("instance", "=", instance);
    const source = await q.executeTakeFirst();
    if (!source) return null;
    const project = await trx
      .insertInto("projects_projects")
      .values({
        instance: source.instance,
        name,
        description: source.description,
        status: "active",
        priority: source.priority,
        color: source.color,
        start_date: null,
        target_date: null,
        completion_date: null,
        metadata: JSON.stringify({ ...(source.metadata ?? {}), copied_from: source.id }) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const tasks = await trx.selectFrom("projects_tasks").selectAll().where("project_id", "=", source.id).where("status", "!=", "cancelled").execute();
    const idOf = new Map<string, string>();
    const copied: { id: string; title: string; metadata: unknown }[] = [];
    for (const t of tasks) {
      const { blocked_on: _gone, ...metadata } = (t.metadata ?? {}) as Record<string, unknown>;
      // check-then-insert: the read only picks the list position or the source tasks; the insert leaves occurrence_of null, the only unique key.
      const row = await trx
        .insertInto("projects_tasks")
        .values({
          instance: t.instance,
          project_id: project.id,
          title: t.title,
          description: t.description,
          status: "todo",
          priority: t.priority,
          energy: t.energy,
          order_within: t.order_within,
          due_date: null,
          completed_at: null,
          metadata: JSON.stringify(metadata) as never,
          checklist: JSON.stringify((t.checklist ?? []).map((c) => ({ ...c, done: false }))) as never,
          repeat: t.repeat ? (JSON.stringify(t.repeat) as never) : null,
        })
        .returning(["id", "title", "metadata"])
        .executeTakeFirstOrThrow();
      idOf.set(t.id, row.id);
      copied.push(row);
    }
    const deps = tasks.length
      ? await trx.selectFrom("projects_task_dependencies").select(["task_id", "depends_on_task_id"]).where("task_id", "in", tasks.map((t) => t.id)).where("depends_on_task_id", "is not", null).execute()
      : [];
    const waiting = new Set<string>();
    for (const d of deps) {
      const task = idOf.get(d.task_id), on = d.depends_on_task_id ? idOf.get(d.depends_on_task_id) : undefined;
      if (!task || !on) continue;
      await trx.insertInto("projects_task_dependencies").values({ task_id: task, depends_on_task_id: on }).execute();
      waiting.add(task);
    }
    return { project, copied, waiting };
  });
  if (!made) return null;
  await platform().activity.log({
    orgId,
    userId,
    action: "project_copied",
    ref: { module: "projects", entityType: "project", entityId: made.project.id },
    diff: { name: made.project.name, copied_from: sourceId, tasks: made.copied.length },
  });
  platform().events.emit("projects.project.created", { orgId, projectId: made.project.id });
  for (const t of made.copied) {
    const person = assigneeOf(t.metadata);
    if (person && !made.waiting.has(t.id)) await tellAssignee(orgId, { ...t, project_name: made.project.name }, person, userId);
  }
  return { project: made.project, tasks: made.copied.length };
}
