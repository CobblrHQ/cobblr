// The order of a project's tasks: one writer for the page's arrows and for
// projects:move-task, so a task moved by asking lands where the list shows it.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { ProjectsDB } from "../db.js";

/** A project's task ids in the order the list shows them. */
export async function taskOrder(db: Kysely<ProjectsDB>, projectId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("projects_tasks")
    .select("id")
    .where("project_id", "=", projectId)
    .orderBy("order_within", "asc")
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => r.id);
}

/** Put the named tasks first, in that order; the ones not named keep their
 *  places after them. Returns the ids that are not in the project, if any,
 *  and writes nothing then. */
export async function writeTaskOrder(db: Kysely<ProjectsDB>, projectId: string, ids: string[]): Promise<string[]> {
  const own = await taskOrder(db, projectId);
  const inProject = new Set(own);
  const stray = ids.filter((id) => !inProject.has(id));
  if (stray.length > 0) return stray;
  const named = new Set(ids);
  const rest = own.filter((id) => !named.has(id));
  await db.transaction().execute(async (trx) => {
    for (const [i, id] of [...ids, ...rest].entries()) {
      await trx.updateTable("projects_tasks").set({ order_within: i }).where("id", "=", id).execute();
    }
  });
  return [];
}

const MOVES = ["first", "last", "up", "down"] as const;

export function registerOrderHandlers(): void {
  platform().actions.registerHandler("projects.move-task", async (ctx) => {
    const task = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
    const row = await db.selectFrom("projects_tasks").select(["project_id"]).where("id", "=", task.id).executeTakeFirst();
    if (!row) return { ok: false, error: `no task with id ${task.id}` };
    const projectId = row.project_id;
    if (!projectId) return { ok: false, error: "This task is not in a project, so it has no list to move in." };
    const ids = await taskOrder(db, projectId);
    const from = ids.indexOf(task.id);
    const to = typeof args.to === "string" ? args.to : "";
    const position = Number(args.position);
    let at: number;
    if ((MOVES as readonly string[]).includes(to)) {
      at = to === "first" ? 0 : to === "last" ? ids.length - 1 : to === "up" ? from - 1 : from + 1;
    } else if (Number.isInteger(position) && position >= 1) {
      at = position - 1;
    } else {
      return { ok: false, error: "Say where: to is first, last, up or down, or position is its place in the list counting from 1." };
    }
    at = Math.max(0, Math.min(ids.length - 1, at));
    ids.splice(from, 1);
    ids.splice(at, 0, task.id);
    await writeTaskOrder(db, projectId, ids);
    return { ok: true, result: { position: at + 1, of: ids.length }, was: { task_id: task.id, position: from + 1 } };
  });

  platform().actions.registerUndo("projects.move-task", (result) => {
    const w = result as { ok?: unknown; was?: { task_id?: unknown; position?: unknown } } | null;
    if (w?.ok !== true || typeof w.was?.task_id !== "string" || typeof w.was.position !== "number") return null;
    return { action_id: "projects:move-task", args: { position: w.was.position }, entity_kind: "projects:task", entity_id: w.was.task_id };
  });
}
