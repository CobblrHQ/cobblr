// projects:blocked-by / :unblock — task dependencies, for the assistant.
//
// The module had set-dep-satisfied (tick an existing dependency off) and
// mark-task-done, and no way to SAY that one task waits on another. "This can't
// start until the frame is welded" is an ordinary sentence and there was no
// door for it.
//
// A dependency can point at another task OR at a record in any module (the
// route takes either shape). Both are offered here: naming a task is the common
// case, and `blocks_kind` + `blocks_id` covers "waiting on that purchase".

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { ProjectsDB } from "../db.js";

const str = (v: unknown): string =>
  typeof v === "string" && v.trim() ? v.trim() : "";

export function registerDependencyHandlers(): void {
  registerUndos();
  platform().actions.registerHandler("projects.blocked-by", async (ctx) => {
    const task = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const dependsOn = str(args.depends_on_task_id);
    const kind = str(args.blocks_kind);
    const id = str(args.blocks_id);

    const isTaskDep = !!dependsOn;
    const isExternal = !!kind && !!id;
    // The route enforces exactly-one, and the DB has a CHECK for it. Say the
    // same thing here rather than letting a constraint violation come back.
    if (isTaskDep === isExternal) {
      return {
        ok: false,
        error:
          "Say what this waits on: either depends_on_task_id (another task) or blocks_kind + blocks_id (a record in any module), not both.",
      };
    }
    if (dependsOn === task.id) return { ok: false, error: "a task cannot wait on itself" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
    if (isTaskDep) {
      const other = await db
        .selectFrom("projects_tasks")
        .select(["id", "title"])
        .where("id", "=", dependsOn)
        .executeTakeFirst();
      if (!other) return { ok: false, error: `no task with id ${dependsOn}` };
    }
    const [targetModule, targetType] = kind.includes(":")
      ? [kind.split(":")[0]!, kind.split(":")[1]!]
      : [kind, kind];

    const row = await db
      .insertInto("projects_task_dependencies")
      .values({
        task_id: task.id,
        depends_on_task_id: isTaskDep ? dependsOn : null,
        target_module: isExternal ? targetModule : null,
        target_entity_type: isExternal ? targetType : null,
        target_entity_id: isExternal ? id : null,
      } as never)
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { ok: true, result: { dependency_id: row.id, note: "Recorded. The task shows as blocked until this is satisfied." } };
  });

  platform().actions.registerHandler("projects.unblock", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const depId = str(args.dependency_id);
    if (!depId) return { ok: false, error: "pass dependency_id: read the task's dependencies to get it" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
    const row = await db
      .deleteFrom("projects_task_dependencies")
      .where("id", "=", depId)
      .returningAll()
      .executeTakeFirst();
    if (!row) return { ok: false, error: `no dependency with id ${depId}` };
    const r = row as Record<string, unknown>;
    return {
      ok: true,
      result: { removed: row.id },
      // What it waited on, so the way back can record the same wait again.
      was: { task_id: r.task_id, depends_on_task_id: r.depends_on_task_id ?? null, blocks_kind: r.blocks_kind ?? null, blocks_id: r.blocks_id ?? null },
    };
  });
}

function registerUndos(): void {
  platform().actions.registerUndo("projects.blocked-by", (result, ctx) => {
    const id = (result as { ok?: unknown; result?: { dependency_id?: unknown } } | null);
    if (id?.ok !== true || typeof id.result?.dependency_id !== "string") return null;
    return { action_id: "projects:unblock", args: { dependency_id: id.result.dependency_id }, ...(ctx.entity ? { entity_kind: ctx.entity.kind, entity_id: ctx.entity.id } : {}) };
  });
  platform().actions.registerUndo("projects.unblock", (result) => {
    const w = (result as { ok?: unknown; was?: { task_id?: unknown; depends_on_task_id?: unknown; blocks_kind?: unknown; blocks_id?: unknown } } | null);
    if (w?.ok !== true || typeof w.was?.task_id !== "string") return null;
    const args = typeof w.was.depends_on_task_id === "string"
      ? { depends_on_task_id: w.was.depends_on_task_id }
      : typeof w.was.blocks_kind === "string" && typeof w.was.blocks_id === "string"
        ? { blocks_kind: w.was.blocks_kind, blocks_id: w.was.blocks_id }
        : null;
    if (!args) return null;
    return { action_id: "projects:blocked-by", args, entity_kind: "projects:task", entity_id: w.was.task_id };
  });
}
