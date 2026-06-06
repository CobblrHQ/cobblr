// /projects — CRUD + a task list endpoint scoped to a project.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
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
      .where("instance", "=", instanceOf(req))
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
      .where("instance", "=", instanceOf(req))
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
        instance: instanceOf(req),
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
      .where("instance", "=", instanceOf(req))
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
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.status(204).end();
  }),
);

// ── AI: extract materials from a pattern (Phase 3) ─────────────────────
// Reads pasted pattern text and returns the yarn + hooks it calls for, via
// core-ai (capability: chat). Degrades to { ai: false } when no provider is
// configured, so the UI can prompt the user instead of erroring.
const ExtractBody = z.object({ text: z.string().min(1).max(20_000) });

projectsRouter.post(
  "/:id/extract-pattern",
  asyncHandler(async (req, res) => {
    const parsed = ExtractBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const system =
      "You read a crochet/knitting pattern and extract ONLY the materials it " +
      "calls for. Reply with ONLY a JSON object, no prose:\n" +
      '{"yarn":[{"fiber":<string|null>,"weight":<string|null, e.g. "Worsted",' +
      '"DK","Aran">,"color":<string|null>,"length_m":<number|null total metres>,' +
      '"skeins":<number|null>}],"hooks":[{"gauge":<string, e.g. "4.0 mm">}]}\n' +
      "Use null when the pattern doesn't state something. If it lists no yarn or " +
      "no hooks, use an empty array. Convert yards to metres (×0.9144).";
    try {
      const r = await platform().ai.invoke({
        orgId: ctx.org.id,
        capability: "chat",
        input: {
          messages: [
            { role: "system", content: system },
            { role: "user", content: parsed.data.text.slice(0, 20_000) },
          ],
        },
        source: { kind: "projects:pattern-extract", id: req.params.id ?? "" },
      });
      const content = (r.result as { content?: string })?.content ?? "";
      const m = content.match(/\{[\s\S]*\}/);
      const obj = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
      if (!obj) {
        res.json({ ai: false, reason: "Couldn't read that pattern — try pasting more of it.", yarn: [], hooks: [] });
        return;
      }
      res.json({
        ai: true,
        yarn: Array.isArray(obj.yarn) ? obj.yarn : [],
        hooks: Array.isArray(obj.hooks) ? obj.hooks : [],
      });
    } catch (e) {
      // No provider / over budget / provider error → graceful degrade.
      res.json({
        ai: false,
        reason:
          e instanceof Error && /provider|capability|budget/i.test(e.message)
            ? "No AI provider is set up for this workspace yet (Configuration → AI)."
            : "AI is unavailable right now.",
        yarn: [],
        hooks: [],
      });
    }
  }),
);
