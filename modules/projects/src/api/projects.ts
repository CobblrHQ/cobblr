// /projects — CRUD + a task list endpoint scoped to a project.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const projectsRouter = Router({ mergeParams: true });

const ProjectCreate = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(8_000).nullable().optional(),
  status: z
    .enum(["planning", "active", "blocked", "done", "abandoned"])
    .optional(),
  priority: z.enum(["low", "med", "high", "urgent"]).nullable().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  completion_date: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PROJECT_NATIVE_KEYS = new Set(Object.keys(ProjectCreate.shape));
const ProjectUpdate = ProjectCreate.partial();

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("projects_projects")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  }),
);

projectsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("projects_projects")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json(row);
  }),
);

projectsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, PROJECT_NATIVE_KEYS);
    const parsed = ProjectCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const inserted = await db
      .insertInto("projects_projects")
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "active",
        priority: parsed.data.priority ?? "med",
        start_date: parsed.data.start_date ? new Date(parsed.data.start_date) : null,
        target_date: parsed.data.target_date ? new Date(parsed.data.target_date) : null,
        completion_date: parsed.data.completion_date ? new Date(parsed.data.completion_date) : null,
        color: parsed.data.color ?? null,
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "project_created",
      ref: { module: "projects", entityType: "project", entityId: inserted.id },
      diff: { name: inserted.name },
    });
    platform().events.emit("projects.project.created", {
      orgId: ctx.org.id,
      projectId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);

projectsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, PROJECT_NATIVE_KEYS);
    const parsed = ProjectUpdate.safeParse(routed);
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
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (
        (k === "start_date" || k === "target_date" || k === "completion_date") &&
        v != null &&
        typeof v === "string"
      ) {
        patch[k] = new Date(v);
      } else {
        patch[k] = v;
      }
    }

    const updated = await db
      .updateTable("projects_projects")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "project_updated",
      ref: { module: "projects", entityType: "project", entityId: updated.id },
      diff: parsed.data,
    });
    platform().events.emit("projects.project.updated", {
      orgId: ctx.org.id,
      projectId: updated.id,
    });

    res.json(updated);
  }),
);

projectsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const deleted = await db
      .deleteFrom("projects_projects")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.status(204).end();
  }),
);
