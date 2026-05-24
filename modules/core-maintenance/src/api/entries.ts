// /api/v1/orgs/:slug/modules/core-maintenance/entries
//
// Polymorphic CRUD — every entry binds to (entity_module,
// entity_type, entity_id). The caller picks the kind: history-only
// (performed_at), scheduled-only (scheduled_at), or both (a thing
// done with a follow-up).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const entriesRouter = Router({ mergeParams: true });

const EntryCreate = z
  .object({
    entity_module: z.string().min(1).max(80),
    entity_type: z.string().min(1).max(80),
    entity_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable().optional(),
    /** ISO date or datetime. */
    performed_at: z.string().nullable().optional(),
    scheduled_at: z.string().nullable().optional(),
    cost_cents: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().max(4_000).nullable().optional(),
    recurrence_rule: z.string().max(500).nullable().optional(),
  })
  .refine(
    (d) => Boolean(d.performed_at) || Boolean(d.scheduled_at),
    {
      message: "Entry needs at least one of performed_at or scheduled_at",
      path: ["performed_at"],
    },
  );

const EntryUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  performed_at: z.string().nullable().optional(),
  scheduled_at: z.string().nullable().optional(),
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(4_000).nullable().optional(),
  recurrence_rule: z.string().max(500).nullable().optional(),
});

const ListQuery = z.object({
  entity_module: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  /** "history" = performed_at is set (regardless of scheduled_at).
   *  "scheduled" = scheduled_at is set AND performed_at is null
   *  (incomplete). "all" = everything. Default: all. */
  kind: z.enum(["history", "scheduled", "all"]).default("all"),
  /** Cap scheduled-at to this many days from now (e.g. "due soon"). */
  due_within_days: z.coerce.number().int().positive().max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

entriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const filter = q.data;
    const db = tenantDb(req);

    let query = db
      .selectFrom("core_maintenance_entries")
      .selectAll();
    if (filter.entity_module) query = query.where("entity_module", "=", filter.entity_module);
    if (filter.entity_type) query = query.where("entity_type", "=", filter.entity_type);
    if (filter.entity_id) query = query.where("entity_id", "=", filter.entity_id);
    if (filter.kind === "history") {
      query = query.where("performed_at", "is not", null);
    } else if (filter.kind === "scheduled") {
      query = query.where("scheduled_at", "is not", null).where("performed_at", "is", null);
    }
    if (filter.due_within_days != null) {
      query = query.where(
        sql<boolean>`scheduled_at is not null and scheduled_at <= (now() + ${filter.due_within_days} * interval '1 day')`,
      );
    }
    const rows = await query
      .orderBy(
        sql<string>`coalesce(scheduled_at, performed_at, created_at)`,
        filter.kind === "scheduled" ? "asc" : "desc",
      )
      .limit(filter.limit)
      .execute();
    res.json({ items: rows });
  }),
);

entriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_maintenance_entries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    res.json(row);
  }),
);

entriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = EntryCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const db = tenantDb(req);

    const row = await db
      .insertInto("core_maintenance_entries")
      .values({
        entity_module: parsed.data.entity_module,
        entity_type: parsed.data.entity_type,
        entity_id: parsed.data.entity_id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        performed_at: parsed.data.performed_at ? new Date(parsed.data.performed_at) : null,
        scheduled_at: parsed.data.scheduled_at ? new Date(parsed.data.scheduled_at) : null,
        cost_cents: parsed.data.cost_cents ?? null,
        performed_by: parsed.data.performed_at ? session.id : null,
        notes: parsed.data.notes ?? null,
        recurrence_rule: parsed.data.recurrence_rule ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    void platform().events.emit("core-maintenance.entry.created", {
      orgId: ctx.org.id,
      entryId: row.id,
      entityModule: row.entity_module,
      entityType: row.entity_type,
      entityId: row.entity_id,
    });
    res.status(201).json(row);
  }),
);

entriesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = EntryUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.performed_at !== undefined) {
      patch.performed_at = parsed.data.performed_at ? new Date(parsed.data.performed_at) : null;
    }
    if (parsed.data.scheduled_at !== undefined) {
      patch.scheduled_at = parsed.data.scheduled_at ? new Date(parsed.data.scheduled_at) : null;
    }
    if (parsed.data.cost_cents !== undefined) patch.cost_cents = parsed.data.cost_cents;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.recurrence_rule !== undefined) {
      patch.recurrence_rule = parsed.data.recurrence_rule;
    }

    const row = await db
      .updateTable("core_maintenance_entries")
      .set(patch as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    void platform().events.emit("core-maintenance.entry.updated", {
      orgId: ctx.org.id,
      entryId: row.id,
    });
    res.json(row);
  }),
);

entriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_maintenance_entries")
      .where("id", "=", id)
      .returning(["id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    void platform().events.emit("core-maintenance.entry.deleted", {
      orgId: ctx.org.id,
      entryId: row.id,
    });
    res.status(204).end();
  }),
);

/** Mark a scheduled entry as done. Convenience over PATCH:
 *  performed_at = now (or supplied date), keeping scheduled_at so
 *  the history shows when it was due vs when it was actually
 *  completed. Optionally spawns a follow-up if recurrence_rule is
 *  set (deferred — Phase 2). */
entriesRouter.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const session = sessionUser(req);
    const db = tenantDb(req);
    const completedAt = typeof req.body?.performed_at === "string"
      ? new Date(req.body.performed_at)
      : new Date();
    const row = await db
      .updateTable("core_maintenance_entries")
      .set({
        performed_at: completedAt,
        performed_by: session.id,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    res.json(row);
  }),
);
