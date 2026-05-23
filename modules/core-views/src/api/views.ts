// /views — saved view CRUD + the /data passthrough that delegates
// to platform.entities.list() for the kind the view targets.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const viewsRouter = Router({ mergeParams: true });

const ViewCreate = z.object({
  entity_kind: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  view_type: z.string().min(1).max(40),
  config: z.record(z.unknown()).optional(),
  is_default: z.boolean().optional(),
  /** v0.3: pin to the dashboard's pinned-views section. */
  pinned: z.boolean().optional(),
  // owner_user_id is set by the route from the JWT — never accepted
  // from the body. NULL means "workspace-shared".
  shared: z.boolean().optional(),
});

const ViewUpdate = ViewCreate.partial();

const DataQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  q: z.string().optional(),
});

viewsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ViewCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const row = await db
      .insertInto("core_views_views")
      .values({
        entity_kind: parsed.data.entity_kind,
        name: parsed.data.name,
        view_type: parsed.data.view_type,
        config: parsed.data.config ?? {},
        is_default: parsed.data.is_default ?? false,
        // shared=true means workspace-shared (owner_user_id NULL).
        // Default is private to the creating user.
        owner_user_id: parsed.data.shared ? null : session?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().events.emit("core-views.view.created", {
      orgId: ctx.org.id,
      viewId: row.id,
      entity_kind: row.entity_kind,
      view_type: row.view_type,
    });
    res.status(201).json(row);
  }),
);

viewsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    // Visibility: workspace-shared (owner null) + own private views.
    let q = db
      .selectFrom("core_views_views")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("owner_user_id", "is", null),
          ...(session ? [eb("owner_user_id", "=", session.id)] : []),
        ]),
      )
      .orderBy("entity_kind")
      .orderBy("name");
    if (kind) q = q.where("entity_kind", "=", kind);
    const items = await q.execute();
    res.json({ items });
  }),
);

viewsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_views_views")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "view not found" } });
      return;
    }
    res.json(row);
  }),
);

viewsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = ViewUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.entity_kind !== undefined) patch.entity_kind = parsed.data.entity_kind;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.view_type !== undefined) patch.view_type = parsed.data.view_type;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;
    if (parsed.data.is_default !== undefined) patch.is_default = parsed.data.is_default;
    if (parsed.data.pinned !== undefined) patch.pinned = parsed.data.pinned;
    // Flipping `shared` toggles ownership null vs current user.
    if (parsed.data.shared !== undefined) {
      const session = sessionUser(req);
      patch.owner_user_id = parsed.data.shared ? null : session?.id ?? null;
    }

    const row = await db
      .updateTable("core_views_views")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "view not found" } });
      return;
    }
    await platform().events.emit("core-views.view.updated", {
      orgId: ctx.org.id,
      viewId: row.id,
    });
    res.json(row);
  }),
);

viewsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .deleteFrom("core_views_views")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "view not found" } });
      return;
    }
    await platform().events.emit("core-views.view.deleted", {
      orgId: ctx.org.id,
      viewId: id,
    });
    res.status(204).end();
  }),
);

// GET /views/:id/data — return the rows that the view should display.
// This is just a thin wrapper around platform.entities.list(): we
// look up the view to find entity_kind, parse any view-config-side
// query knobs (filter, sort), merge with request-level query params,
// then call list().
viewsRouter.get(
  "/:id/data",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const view = await db
      .selectFrom("core_views_views")
      .select(["id", "entity_kind", "view_type", "config"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!view) {
      res.status(404).json({ error: { code: "not_found", message: "view not found" } });
      return;
    }
    const parsedQuery = DataQuery.safeParse(req.query);
    if (!parsedQuery.success) return badBody(res, parsedQuery.error);
    const cfg = view.config as Record<string, unknown>;
    const result = await platform().entities.list(ctx.org.id, view.entity_kind, {
      limit: parsedQuery.data.limit,
      offset: parsedQuery.data.offset,
      q: parsedQuery.data.q,
      // Pull filter/sort from the persisted view config. The shape
      // is "whatever the view editor wrote" — modules ignore unknown
      // keys, so a request-level override layered on top is safe.
      filter: (cfg.filter as Record<string, unknown> | undefined) ?? undefined,
      // D10: comparison predicates beyond equality (qty < min_qty,
      // due_date <= now, etc). Resolvers that don't support them
      // ignore — degrades to "no extra filter" rather than erroring.
      where: (cfg.where as never) ?? undefined,
      sort: (cfg.sort as string[] | undefined) ?? undefined,
    });
    res.json({
      view: { id: view.id, entity_kind: view.entity_kind, view_type: view.view_type },
      ...result,
    });
  }),
);

// Re-export a no-op SQL helper so kysely typing stays happy when
// future routes need a raw expression. Keeps the import alongside
// the rest of the route module.
void sql;
