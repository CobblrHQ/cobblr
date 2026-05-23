// /tasks — full CRUD + the dependency sub-collection + a
// "what's next" picker. Status transitions go through PATCH so
// completed_at can be stamped server-side.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const tasksRouter = Router({ mergeParams: true });

const TaskCreate = z.object({
  project_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(320),
  description: z.string().max(8_000).nullable().optional(),
  status: z.enum(["todo", "doing", "done", "blocked", "cancelled"]).optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  energy: z.enum(["small", "medium", "large"]).nullable().optional(),
  due_date: z.string().nullable().optional(),
});

const TASK_NATIVE_KEYS = new Set(Object.keys(TaskCreate.shape));
const TaskUpdate = TaskCreate.partial();

const ListQuery = z.object({
  project_id: z.string().uuid().optional(),
  status: z.enum(["todo", "doing", "done", "blocked", "cancelled"]).optional(),
  energy: z.enum(["small", "medium", "large"]).optional(),
  // ?blocked=1 returns only tasks with at least one unsatisfied dep.
  blocked: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const DependencyCreate = z.object({
  depends_on_task_id: z.string().uuid().optional(),
  target_module: z.string().min(1).max(80).optional(),
  target_entity_type: z.string().min(1).max(80).optional(),
  target_entity_id: z.string().min(1).max(120).optional(),
  note: z.string().max(500).optional(),
});

tasksRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    let q = db
      .selectFrom("projects_tasks as t")
      .leftJoin("projects_projects as p", "p.id", "t.project_id")
      .select([
        "t.id", "t.project_id", "t.title", "t.description",
        "t.status", "t.priority", "t.energy", "t.due_date",
        "t.completed_at", "t.metadata", "t.created_at", "t.updated_at",
        "p.name as project_name",
        // Count unsatisfied deps so the UI can show "(blocked: 2)".
        (eb) =>
          eb
            .selectFrom("projects_task_dependencies as d")
            .select(sql<string>`coalesce(count(*), 0)`.as("v"))
            .whereRef("d.task_id", "=", "t.id")
            .where("d.satisfied", "=", false)
            .as("blocked_deps"),
      ])
      .orderBy("t.created_at", "desc")
      .limit(parsed.data.limit);

    if (parsed.data.project_id) q = q.where("t.project_id", "=", parsed.data.project_id);
    if (parsed.data.status) q = q.where("t.status", "=", parsed.data.status);
    if (parsed.data.energy) q = q.where("t.energy", "=", parsed.data.energy);

    const rows = await q.execute();
    const items = rows.map((r) => ({
      ...r,
      blocked_deps: Number(r.blocked_deps ?? 0),
    }));
    const filtered =
      parsed.data.blocked === "1" ? items.filter((t) => t.blocked_deps > 0) : items;
    res.json({ items: filtered });
  }),
);

tasksRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const task = await db
      .selectFrom("projects_tasks")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!task) {
      res.status(404).json({ error: { code: "not_found", message: "task not found" } });
      return;
    }
    const deps = await db
      .selectFrom("projects_task_dependencies")
      .selectAll()
      .where("task_id", "=", id)
      .execute();
    res.json({ ...task, dependencies: deps });
  }),
);

tasksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, TASK_NATIVE_KEYS);
    const parsed = TaskCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const inserted = await db
      .insertInto("projects_tasks")
      .values({
        project_id: parsed.data.project_id ?? null,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "todo",
        priority: parsed.data.priority ?? "med",
        energy: parsed.data.energy ?? "medium",
        due_date: parsed.data.due_date ? new Date(parsed.data.due_date) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "task_created",
      ref: { module: "projects", entityType: "task", entityId: inserted.id },
      diff: { title: inserted.title, project_id: inserted.project_id },
    });
    platform().events.emit("projects.task.created", {
      orgId: ctx.org.id,
      taskId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);

tasksRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, TASK_NATIVE_KEYS);
    const parsed = TaskUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    let completed = false;
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (k === "due_date" && v != null && typeof v === "string") {
        patch[k] = new Date(v);
      } else if (k === "status" && v === "done") {
        patch[k] = v;
        patch.completed_at = new Date();
        completed = true;
      } else if (k === "status" && v !== "done") {
        patch[k] = v;
        // Un-completing — null out the completion timestamp.
        patch.completed_at = null;
      } else {
        patch[k] = v;
      }
    }

    const updated = await db
      .updateTable("projects_tasks")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "task not found" } });
      return;
    }

    const action = completed ? "task_completed" : "task_updated";
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action,
      ref: { module: "projects", entityType: "task", entityId: updated.id },
      diff: parsed.data,
    });
    platform().events.emit(`projects.task.${completed ? "completed" : "updated"}`, {
      orgId: ctx.org.id,
      taskId: updated.id,
    });

    res.json(updated);
  }),
);

tasksRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const deleted = await db
      .deleteFrom("projects_tasks")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "task not found" } });
      return;
    }
    res.status(204).end();
  }),
);

// ─────────────────────── Dependencies sub-routes ─────────────────

tasksRouter.post(
  "/:id/dependencies",
  asyncHandler(async (req, res) => {
    const parsed = DependencyCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    // Exactly one of (depends_on_task_id) or (target_module + type + id)
    // must be set. CHECK constraint at DB level too, but bail out
    // with a nicer 400 before we go round-tripping.
    const isTaskDep = !!parsed.data.depends_on_task_id;
    const isExternalDep =
      !!parsed.data.target_module && !!parsed.data.target_entity_type && !!parsed.data.target_entity_id;
    if (isTaskDep === isExternalDep) {
      res.status(400).json({
        error: {
          code: "invalid_dep",
          message:
            "Provide either depends_on_task_id OR (target_module + target_entity_type + target_entity_id), not both.",
        },
      });
      return;
    }

    const db = tenantDb(req);
    const inserted = await db
      .insertInto("projects_task_dependencies")
      .values({
        task_id: id,
        depends_on_task_id: parsed.data.depends_on_task_id ?? null,
        target_module: parsed.data.target_module ?? null,
        target_entity_type: parsed.data.target_entity_type ?? null,
        target_entity_id: parsed.data.target_entity_id ?? null,
        note: parsed.data.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    res.status(201).json(inserted);
  }),
);

tasksRouter.delete(
  "/:id/dependencies/:depId",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const depId = req.params.depId;
    if (!id || !depId) {
      res.status(400).json({ error: { code: "missing_id", message: "ids required" } });
      return;
    }
    const db = tenantDb(req);
    const deleted = await db
      .deleteFrom("projects_task_dependencies")
      .where("id", "=", depId)
      .where("task_id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "dependency not found" } });
      return;
    }
    res.status(204).end();
  }),
);
