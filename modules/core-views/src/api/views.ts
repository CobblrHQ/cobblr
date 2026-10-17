import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { GroupingError, readGroupKeys } from "@cobblr/platform-contract/grouped-list";
// /views — saved view CRUD + the /data passthrough that delegates
// to platform.entities.list() for the kind the view targets.

import { Router, type Response } from "express";
import { z } from "zod";
import { sql, type ExpressionBuilder } from "kysely";
import { platform, viewQuery } from "@cobblr/platform-contract";
import { csvDownloadHeaders } from "@cobblr/platform-contract/csv";
import { sessionUser, tenantContext, tenantDb, type CoreViewsDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const viewsRouter = Router({ mergeParams: true });

/** Exported so the core-views:save-view handler validates a view the SAME way
 *  this route does — what counts as a valid view must not mean one thing when a
 *  person saves one and another when the assistant does. */
export const ViewCreate = z.object({
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
  group_offset: z.coerce.number().int().min(0).optional(),
  group_limit: z.coerce.number().int().min(1).max(20).optional(),
  group_keys: z.string().transform(readGroupKeys).optional(),
  /** The reader's calendar day, for a view that compares a date with
   *  "today" (a "Ready to drink" window). */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** A view is someone's to see when it is shared (no owner) or theirs. Every
 *  route that takes an id reads through this, so another member's private view
 *  answers 404 exactly like a view that does not exist: never "forbidden", which
 *  would say it is there. */
export function visibleTo(userId: string | null) {
  return (eb: ExpressionBuilder<CoreViewsDB, "core_views_views">) =>
    eb.or([eb("owner_user_id", "is", null), ...(userId ? [eb("owner_user_id", "=", userId)] : [])]);
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "view not found" } });
}

// AI-ACTION: core-views:save-view
viewsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-views:save-view"))) return;
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
        pinned: parsed.data.pinned ?? false,
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
      .where(visibleTo(sessionUser(req)?.id ?? null))
      .executeTakeFirst();
    if (!row) return notFound(res);
    res.json(row);
  }),
);

// AI-ACTION: core-views:edit-view
viewsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-views:edit-view"))) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = ViewUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const current = await db
      .selectFrom("core_views_views")
      .select(["id", "owner_user_id"])
      .where("id", "=", id)
      .where(visibleTo(userId))
      .executeTakeFirst();
    if (!current) return notFound(res);
    // Taking a shared view private takes it away from everyone else, so it is
    // an owner or admin's call, the same tier that curates the workspace.
    if (parsed.data.shared === false && current.owner_user_id === null && !["owner", "admin"].includes(ctx.role)) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only an owner or admin can make a shared view private; it would disappear for everyone else." },
      });
      return;
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.entity_kind !== undefined) patch.entity_kind = parsed.data.entity_kind;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.view_type !== undefined) patch.view_type = parsed.data.view_type;
    if (parsed.data.config !== undefined) patch.config = parsed.data.config;
    if (parsed.data.is_default !== undefined) patch.is_default = parsed.data.is_default;
    if (parsed.data.pinned !== undefined) patch.pinned = parsed.data.pinned;
    // Flipping `shared` toggles ownership null vs current user.
    if (parsed.data.shared !== undefined) {
      patch.owner_user_id = parsed.data.shared ? null : userId;
    }

    const row = await db
      .updateTable("core_views_views")
      .set(patch)
      .where("id", "=", id)
      .where(visibleTo(userId))
      .returningAll()
      .executeTakeFirst();
    if (!row) return notFound(res);
    await platform().events.emit("core-views.view.updated", {
      orgId: ctx.org.id,
      viewId: row.id,
    });
    res.json(row);
  }),
);

// AI-ACTION: core-views:delete-view
viewsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-views:delete-view"))) return;
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
      .where(visibleTo(sessionUser(req)?.id ?? null))
      .returning("id")
      .executeTakeFirst();
    if (!row) return notFound(res);
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
      .select(["id", "name", "entity_kind", "view_type", "config"])
      .where("id", "=", id)
      .where(visibleTo(sessionUser(req)?.id ?? null))
      .executeTakeFirst();
    if (!view) return notFound(res);
    const parsedQuery = DataQuery.safeParse(req.query);
    if (!parsedQuery.success) return badBody(res, parsedQuery.error);
    // The day the view's "today" means: the one the client says it is in,
    // else the person's (their zone, else the day that has arrived
    // everywhere). Never the server's UTC day.
    const today = await platform().accounts.dayFor(sessionUser(req)?.id ?? null, { said: parsedQuery.data.today });
    const query = {
      ...(view.view_type === "table" && (view.config as Record<string, unknown>)?.group_by ? { group_by: (view.config as { group_by: string }).group_by, group_offset: parsedQuery.data.group_offset, group_limit: parsedQuery.data.group_limit, group_keys: parsedQuery.data.group_keys } : {}),
      q: parsedQuery.data.q,
      today,
      // The view's own query (filter, where, sort), read the one way every
      // surface reads it. Resolvers ignore what they cannot honour, so a
      // request-level override layered on top is safe.
      ...viewQuery(view.config as Record<string, unknown>, today),
    };
    // H2 — viewer identity so the kernel applies per-field read-scope:
    // a member sees only the fields their capabilities permit (e.g.
    // parts but not prices); owner/admin see everything.
    const viewer = { userId: sessionUser(req)?.id, role: ctx.role };
    // A view asked for without a limit is the WHOLE view: a board's columns
    // and counts are about every record, and one resolver page (50) drew
    // "50 3D printers" of 56 and dropped a column. A caller that wants a
    // preview asks for a limit and gets that page with the true total.
    const { limit, offset } = parsedQuery.data;
    const read = async (q: typeof query) =>
      !q.group_by && limit === undefined && offset === undefined
        ? await platform().entities.listAll(ctx.org.id, view.entity_kind, q, viewer)
        : await (async () => {
            const page = await platform().entities.list(ctx.org.id, view.entity_kind, { ...q, limit, offset }, viewer);
            const total = page.total ?? null;
            return { ...page, total, complete: total !== null && (offset ?? 0) + page.items.length >= total };
          })();
    // The grouping is the view's own, saved earlier, not this request's: an
    // older bundle's view can name a field its records do not have (Lego
    // 0.6.4's "By part category"). Refusing it opened a pinned view onto an
    // error; the rows come back ungrouped and the answer says why.
    let ungrouped: { group_by: unknown; reason: string } | undefined;
    const result = await read(query).catch(async (err: unknown) => {
      if (!(err instanceof GroupingError) || !query.group_by || parsedQuery.data.group_keys) throw err;
      ungrouped = { group_by: query.group_by, reason: err.message };
      const { group_by: _by, group_offset: _go, group_limit: _gl, group_keys: _gk, ...flat } = query;
      return read(flat);
    });
    // An empty answer is one of two things, and the page cannot tell them
    // apart from the rows alone: the collection has nothing yet (a fresh
    // install opening its cover wall) or the view's own filter excluded
    // everything it has ("What's on hand" when everything ran out). The first
    // wants a first-item door, the second the filter named. One cheap probe
    // without the view's query, only on the empty path, says which.
    const collectionEmpty =
      result.items.length === 0
        ? (await platform().entities.list(ctx.org.id, view.entity_kind, { limit: 1 }, { userId: sessionUser(req)?.id, role: ctx.role })).items
            .length === 0
        : false;
    res.json({
      view: { id: view.id, name: view.name, entity_kind: view.entity_kind, view_type: view.view_type },
      ...result,
      collection_empty: collectionEmpty,
      ...(ungrouped ? { ungrouped } : {}),
    });
  }),
);

// The view as a spreadsheet: its filter, its sort and (for a table) its
// columns, read as the viewer through the one export seam, so a field their
// role may not read is not in the file.
// AI-REACH: exempt (a file download for a person; the assistant reads the same rows through /data)
viewsRouter.get(
  "/:id/export.csv",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const view = await tenantDb(req)
      .selectFrom("core_views_views")
      .select(["name", "entity_kind", "config"])
      .where("id", "=", id)
      .where(visibleTo(sessionUser(req)?.id ?? null))
      .executeTakeFirst();
    if (!view) return notFound(res);
    const config = (view.config ?? {}) as Record<string, unknown>;
    const today = await platform().accounts.dayFor(sessionUser(req)?.id ?? null, {
      said: typeof req.query.today === "string" ? req.query.today : undefined,
    });
    const only = Array.isArray(config.visible_fields) ? config.visible_fields.filter((f): f is string => typeof f === "string") : undefined;
    const out = await platform().entities.exportCsv(
      ctx.org.id,
      view.entity_kind,
      { today, ...viewQuery(config, today), ...(req.query.subtotals === "true" && config.group_by ? { group_by: config.group_by as string, group_subtotals: true } : {}) },
      { userId: sessionUser(req)?.id, role: ctx.role },
      only,
    );
    if (!out) return notFound(res);
    const stamp = out.filename.match(/\d{4}-\d{2}-\d{2}\.csv$/)?.[0] ?? "export.csv";
    const named = view.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    res.set(csvDownloadHeaders(`${named || "view"}-${stamp}`, out.complete)).send(out.csv);
  }),
);

// Re-export a no-op SQL helper so kysely typing stays happy when
// future routes need a raw expression. Keeps the import alongside
// the rest of the route module.
void sql;
