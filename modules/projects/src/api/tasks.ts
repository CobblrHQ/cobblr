// /tasks — full CRUD + the dependency sub-collection + a
// "what's next" picker. Status transitions go through PATCH so
// completed_at can be stamped server-side.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { ENERGIES, PRIORITIES, TASK_STATUSES } from "../vocab.js";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { dependenciesOf, openBlockerCount, refuseNewTaskDependency, releaseDependentsOf } from "./deps.js";
import { assigneeOf, tellAssignee } from "./assignee.js";
import { makeNextOccurrence } from "./repeat.js";
import { writeTaskOrder } from "./order.js";
import { routeUnknownToMetadata, refuseUnknownFields, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";

export const tasksRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router. (Audit 2026-06-26 P0 #1.)
tasksRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const TaskCreate = z.object({
  project_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(320),
  description: z.string().max(8_000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  energy: z.enum(ENERGIES).nullable().optional(),
  due_date: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  /** Comes round again when done; null stops it. */
  // anchor_day rides along so editing the rule mid-series (a Feb 28 of a
  // series on the 31st) keeps the day the series returns to.
  repeat: z
    .object({ every_n: z.number().int().min(1).max(365), every_unit: z.enum(["day", "week", "month", "year"]), anchor_day: z.number().int().min(1).max(31).optional() })
    .nullable()
    .optional(),
  /** The whole checklist, in order; a save replaces it. */
  checklist: z
    .array(z.object({ id: z.string().min(1).max(64), text: z.string().trim().min(1).max(500), done: z.boolean() }))
    .max(200)
    .optional(),
});

const TASK_NATIVE_KEYS = new Set(Object.keys(TaskCreate.shape));
const TaskUpdate = TaskCreate.partial();

const ListQuery = z.object({
  project_id: z.string().uuid().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  energy: z.enum(ENERGIES).optional(),
  // ?blocked=1 returns only tasks with at least one unsatisfied dep.
  /** One person's tasks: a People entry's id, as the `assignee` field stores it. */
  assignee: z.union([z.literal("me"), z.string().uuid()]).optional(),
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

// AI-REACH: exempt — dashboard-only count; Cobb reads tasks and dependencies.
tasksRouter.get("/dashboard", asyncHandler(async (req, res) => {
  const counts = await tenantDb(req).selectFrom("projects_tasks as t")
    .select(sql<number>`count(*) filter (where ${openBlockerCount("t.id")} > 0)::int`.as("blocked"))
    .executeTakeFirstOrThrow();
  res.json(counts);
}));

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
        "t.completed_at", "t.metadata", "t.created_at", "t.updated_at", "t.checklist", "t.order_within", "t.repeat",
        "p.name as project_name",
        // Open blockers, so the UI can show "blocked: 2".
        openBlockerCount("t.id").as("blocked_deps"),
      ])
      // The order a person put them in; untouched tasks (all 0) newest first,
      // as before there was an order.
      .orderBy("t.order_within", "asc")
      .orderBy("t.created_at", "desc")
      .limit(parsed.data.limit);

    if (parsed.data.project_id) q = q.where("t.project_id", "=", parsed.data.project_id);
    if (parsed.data.status) q = q.where("t.status", "=", parsed.data.status);
    if (parsed.data.energy) q = q.where("t.energy", "=", parsed.data.energy);
    if (parsed.data.assignee) {
      const who =
        parsed.data.assignee === "me"
          ? await platform().accounts.personForUser(tenantContext(req).org.id, sessionUser(req).id)
          : parsed.data.assignee;
      // "Mine" for someone with no People entry is nothing, never everything.
      q = q.where(sql<string>`t.metadata->>'assignee'`, "=", who ?? "00000000-0000-0000-0000-000000000000");
    }
    // In SQL, before the limit: filtering the page afterwards dropped blocked
    // tasks that sat past the first 100.
    if (parsed.data.blocked === "1") q = q.where(sql<boolean>`${openBlockerCount("t.id")} > 0`);
    if (parsed.data.blocked === "0") q = q.where(sql<boolean>`${openBlockerCount("t.id")} = 0`);

    const rows = await q.execute();
    const items = rows.map((r) => ({
      ...r,
      blocked_deps: Number(r.blocked_deps ?? 0),
    }));
    // Person fields read as the person's name (assignee_label).
    res.json({ items: await platform().entities.withFieldLabels(tenantContext(req).org.id, "projects:task", items) });
  }),
);

// A project's tasks in the order a person put them: the whole list, top first.
// AI-ACTION: projects:move-task
// AI-REACH: action projects:move-task
tasksRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "projects:move-task"))) return;
    const parsed = z.object({ project_id: z.string().uuid(), ids: z.array(z.string().uuid()).min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const stray = await writeTaskOrder(db, parsed.data.project_id, parsed.data.ids);
    if (stray.length > 0) {
      res.status(400).json({ error: { code: "not_in_project", message: "Every task in the order must belong to that project.", details: { stray } } });
      return;
    }
    res.json({ ok: true });
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
    const deps = await dependenciesOf(db, id);
    const [labelled] = await platform().entities.withFieldLabels(tenantContext(req).org.id, "projects:task", [task as Record<string, unknown>]);
    res.json({ ...labelled, dependencies: deps, blocked_deps: deps.filter((d) => d.open).length });
  }),
);

tasksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, TASK_NATIVE_KEYS, "projects:task");
    const routed = routeUnknownToMetadata(req.body, TASK_NATIVE_KEYS);
    const parsed = TaskCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // A new task goes on top of its project's list, where it always appeared.
    const top = parsed.data.project_id
      ? await db
          .selectFrom("projects_tasks")
          .select(sql<number>`coalesce(min(order_within), 0)`.as("m"))
          .where("project_id", "=", parsed.data.project_id)
          .executeTakeFirst()
      : undefined;
    const inserted = await db
      .insertInto("projects_tasks")
      .values({
        ...(top ? { order_within: Number(top.m) - 1 } : {}),
        project_id: parsed.data.project_id ?? null,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "todo",
        priority: parsed.data.priority ?? "med",
        energy: parsed.data.energy ?? "medium",
        due_date: parsed.data.due_date ? new Date(parsed.data.due_date) : null,
        ...(parsed.data.checklist ? { checklist: JSON.stringify(parsed.data.checklist) as never } : {}),
        ...(parsed.data.repeat ? { repeat: JSON.stringify(parsed.data.repeat) as never } : {}),
        // D6: hoisted-from-top-level keys live here.
        ...(parsed.data.metadata && Object.keys(parsed.data.metadata).length > 0
          ? { metadata: parsed.data.metadata as never }
          : {}),
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
    const assignee = assigneeOf(inserted.metadata);
    if (assignee) await tellAssignee(ctx.org.id, inserted, assignee, session.id);

    res.status(201).json(inserted);
  }),
);

tasksRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, TASK_NATIVE_KEYS, "projects:task");
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

    // The whole row: the assignee check reads it, and the log says what this
    // edit changed, old → new (#4517).
    const before = await db.selectFrom("projects_tasks").selectAll().where("id", "=", id).executeTakeFirst();
    const patch: Record<string, unknown> = { updated_at: new Date() };
    let completed = false;
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (k === "due_date" && v != null && typeof v === "string") {
        patch[k] = new Date(v);
      } else if (k === "repeat") {
        patch[k] = v === null ? null : JSON.stringify(v);
      } else if (k === "checklist") {
        patch[k] = JSON.stringify(v);
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
      // Merge, never replace: one custom field saved must not erase the others.
      .set(withMetadataMerged(patch) as never)
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
      before,
    });
    platform().events.emit(completed ? "projects.task.completed" : "projects.task.updated", {
      orgId: ctx.org.id,
      taskId: updated.id,
    });
    const nowAssignee = assigneeOf(updated.metadata);
    if (nowAssignee && nowAssignee !== assigneeOf(before?.metadata)) {
      await tellAssignee(ctx.org.id, updated, nowAssignee, session?.id ?? null);
    }
    // Closing a task (done or cancelled) is what frees the tasks waiting on it.
    const closed = (st: string | undefined) => st === "done" || st === "cancelled";
    if (closed(updated.status) && !closed(before?.status)) {
      await releaseDependentsOf(ctx.org.id, db, updated.id);
    }
    // Done (not cancelled): a repeating task comes round again.
    if (updated.status === "done" && before?.status !== "done") {
      await makeNextOccurrence(ctx.org.id, db, updated.id);
    }

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

// AI-ACTION: projects:blocked-by
tasksRouter.post(
  "/:id/dependencies",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "projects:blocked-by"))) return;
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
    if (parsed.data.depends_on_task_id) {
      const refused = await refuseNewTaskDependency(db, id, parsed.data.depends_on_task_id);
      if (refused) {
        res.status(400).json({ error: { code: "invalid_dep", message: refused } });
        return;
      }
    } else if (!(await db.selectFrom("projects_tasks").select("id").where("id", "=", id).executeTakeFirst())) {
      res.status(404).json({ error: { code: "not_found", message: "task not found" } });
      return;
    }
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

// AI-ACTION: projects:unblock
tasksRouter.delete(
  "/:id/dependencies/:depId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "projects:unblock"))) return;
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
