// Action handlers + entity-kind resolvers. Registered at module
// load via api/index.ts's side-effect call.
//
// Replaces the old hardcoded inventory.stock.changed subscriber.
// The platform routes the projects:set-dep-satisfied action here;
// the user-configured wire decides when it fires (default seeded
// at signup is on inventory.stock.changed).

import { sql, type Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";

let registered = false;

export function registerProjectsHandlers(): void {
  if (registered) return;
  registered = true;

  // Entity-kind resolvers ─────────────────────────────────────────
  platform().entities.registerResolver(
    "projects:project",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
      const row = await db
        .selectFrom("projects_projects")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toResolvedProject(row);
    },
  );

  platform().entities.registerResolver(
    "projects:task",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
      const row = await db
        .selectFrom("projects_tasks")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return toResolvedTask(row);
    },
  );

  // List resolvers — let core-views / core-search iterate without
  // each consumer learning our table layout.
  platform().entities.registerListResolver("projects:project", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("projects_projects").selectAll();
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(eb.fn("lower", ["name"]), "like", needle),
          eb(eb.fn("lower", ["description"]), "like", needle),
        ]),
      );
    }
    if (query.filter) {
      const NATIVE = new Set(["status", "priority"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'projects'
              and a.source_type = 'project'
              and a.source_id = projects_projects.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          if (typeof val === "string") q = q.where(key as never, "=", val as never);
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    const sortable = new Set(["name", "target_date", "created_at", "updated_at"]);
    const specs = (query.sort ?? ["-updated_at"]).filter((s) =>
      sortable.has(s.replace(/^-/, "")),
    );
    for (const spec of specs) {
      const desc = spec.startsWith("-");
      const col = spec.replace(/^-/, "");
      q = q.orderBy(col as never, desc ? "desc" : "asc");
    }
    const rows = await q.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedProject(r)) };
  });

  platform().entities.registerListResolver("projects:task", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
    const limit = Math.min(query.limit ?? 50, 200);
    const offset = query.offset ?? 0;
    let q = db.selectFrom("projects_tasks").selectAll();
    if (query.q) {
      const needle = `%${query.q.toLowerCase()}%`;
      q = q.where((eb) =>
        eb.or([
          eb(eb.fn("lower", ["title"]), "like", needle),
          eb(eb.fn("lower", ["description"]), "like", needle),
        ]),
      );
    }
    if (query.filter) {
      const NATIVE = new Set(["status", "project_id", "priority", "energy"]);
      for (const [key, val] of Object.entries(query.filter)) {
        if (val === undefined || val === null) continue;
        if (key === "_tag") {
          const tagName = String(val).trim().toLowerCase();
          q = q.where(sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'projects'
              and a.source_type = 'task'
              and a.source_id = projects_tasks.id
              and lower(t.name) = ${tagName}
          )`);
          continue;
        }
        if (NATIVE.has(key)) {
          if (typeof val === "string") q = q.where(key as never, "=", val as never);
          continue;
        }
        q = q.where(sql<boolean>`metadata ->> ${key} = ${String(val)}`);
      }
    }
    // D10: comparison predicates on task date/state columns. Most
    // useful for "tasks due before now" overdue / today's-todo views.
    if (query.where) {
      const COMPARABLE = new Set(["due_date", "completed_at", "created_at", "updated_at"]);
      for (const p of query.where) {
        if (!COMPARABLE.has(p.col)) continue;
        if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) continue;
        if (p.ref_col) {
          if (!COMPARABLE.has(p.ref_col)) continue;
          q = q.where(
            sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${sql.ref(p.ref_col)}`,
          );
        } else if (p.value !== undefined) {
          const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
          q = q.where(sql<boolean>`${sql.ref(p.col)} ${sql.raw(p.op)} ${v}`);
        }
      }
    }
    const sortable = new Set(["title", "due_date", "created_at", "updated_at"]);
    const specs = (query.sort ?? ["-updated_at"]).filter((s) =>
      sortable.has(s.replace(/^-/, "")),
    );
    for (const spec of specs) {
      const desc = spec.startsWith("-");
      const col = spec.replace(/^-/, "");
      q = q.orderBy(col as never, desc ? "desc" : "asc");
    }
    const rows = await q.limit(limit).offset(offset).execute();
    return { items: rows.map((r) => toResolvedTask(r)) };
  });

  // Action handler ─────────────────────────────────────────────────
  // The platform calls this when a wire targeting
  // projects:set-dep-satisfied fires. The wire's event payload
  // tells us WHICH entity changed; we flip every matching task
  // dep to satisfied + emit a projects.task.unblocked event so
  // notifications / UI can react.
  platform().actions.registerHandler(
    "projects.set-dep-satisfied",
    async (ctx) => {
      if (!ctx.entityKind || !ctx.entityId) {
        return { ok: true, flipped: 0, reason: "no entity" };
      }
      // entityKind here looks like "inventory:part" (or whatever
      // the wire's source_kind was). We store the dep target as
      // (target_module, target_entity_type, target_entity_id) —
      // split the kind for lookup.
      const [module, entityType] = ctx.entityKind.split(":");
      if (!module || !entityType) {
        return { ok: true, flipped: 0, reason: "bad kind" };
      }
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
      const updated = await db
        .updateTable("projects_task_dependencies")
        .set({ satisfied: true })
        .where("target_module", "=", module)
        .where("target_entity_type", "=", entityType)
        .where("target_entity_id", "=", ctx.entityId)
        .where("satisfied", "=", false)
        .returning(["id", "task_id"])
        .execute();
      for (const dep of updated) {
        platform().events.emit("projects.task.unblocked", {
          orgId: ctx.orgId,
          taskId: dep.task_id,
          via: { kind: ctx.entityKind, id: ctx.entityId },
        });
      }
      return { ok: true, flipped: updated.length };
    },
  );

  // Mark a linked task done when an upstream event reports its work is
  // finished. Default wire: digifab.print.completed (a print job that
  // completes auto-closes the task it was linked to). The task id rides
  // on the event payload as `linkedTaskId` — the wire's target entity is
  // the *source* (the print job), which this handler ignores; it reads
  // the payload directly. Loose-coupled: digifab never imports projects.
  platform().actions.registerHandler("projects.mark-task-done", async (ctx) => {
    const taskId = ctx.event?.payload?.linkedTaskId;
    if (typeof taskId !== "string" || !taskId) {
      return { ok: true, completed: 0, reason: "no linked task" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
    // Idempotent — only flips a task that isn't already done, so a
    // re-fired wire never re-stamps completed_at.
    const updated = await db
      .updateTable("projects_tasks")
      .set({ status: "done", completed_at: new Date(), updated_at: new Date() })
      .where("id", "=", taskId)
      .where("status", "!=", "done")
      .returning(["id"])
      .executeTakeFirst();
    if (!updated) return { ok: true, completed: 0, reason: "missing or already done" };
    platform().events.emit("projects.task.completed", { orgId: ctx.orgId, taskId: updated.id });
    return { ok: true, completed: 1, taskId: updated.id };
  });
}

function toResolvedProject(row: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string | null;
  start_date: Date | null;
  target_date: Date | null;
}): ResolvedEntity {
  return {
    kind: "projects:project",
    id: row.id,
    title: row.name,
    subtitle: row.status,
    detailUrl: `/projects/${row.id}`,
    fields: {
      name: row.name,
      description: row.description,
      status: row.status,
      priority: row.priority,
      start_date: row.start_date,
      target_date: row.target_date,
    },
  };
}

function toResolvedTask(row: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  energy: string | null;
  due_date: Date | null;
}): ResolvedEntity {
  return {
    kind: "projects:task",
    id: row.id,
    title: row.title,
    subtitle: row.status,
    fields: {
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      energy: row.energy,
      due_date: row.due_date,
    },
  };
}
