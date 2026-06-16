// /tags — tag CRUD. /assignments — polymorphic attach/detach + list.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const tagsRouter = Router({ mergeParams: true });

const TagCreate = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(40).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
});

const TagUpdate = TagCreate.partial();

const TagMerge = z.object({ into_tag_id: z.string().uuid() });

const AttachBody = z.object({
  tag_name: z.string().min(1).max(60).optional(),
  tag_id: z.string().uuid().optional(),
  color: z.string().max(40).nullable().optional(),
  source_module: z.string().min(1).max(80),
  source_type: z.string().min(1).max(80),
  source_id: z.string().uuid(),
}).refine(
  (d) => Boolean(d.tag_name) !== Boolean(d.tag_id),
  { message: "exactly one of tag_name or tag_id must be provided" },
);

tagsRouter.post(
  "/tags",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = TagCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    try {
      const row = await db
        .insertInto("core_tags_tags")
        .values({
          name: parsed.data.name.trim(),
          color: parsed.data.color ?? null,
          parent_id: parsed.data.parent_id ?? null,
          icon: parsed.data.icon ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await platform().events.emit("core-tags.tag.created", {
        orgId: ctx.org.id,
        tagId: row.id,
        name: row.name,
      });
      res.status(201).json(row);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        // Name collision — return the existing row so callers don't
        // have to round-trip to re-look-up.
        const existing = await db
          .selectFrom("core_tags_tags")
          .selectAll()
          .where(sql`lower(name)`, "=", parsed.data.name.trim().toLowerCase())
          .executeTakeFirst();
        if (existing) {
          res.status(409).json({
            error: { code: "tag_exists", message: "Tag already exists." },
            tag: existing,
          });
          return;
        }
      }
      throw err;
    }
  }),
);

tagsRouter.get(
  "/tags",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("core_tags_tags")
      .selectAll()
      .orderBy("name")
      .execute();
    res.json({ items });
  }),
);

tagsRouter.patch(
  "/tags/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = TagUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.color !== undefined) patch.color = parsed.data.color;
    if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
    if (parsed.data.parent_id !== undefined) {
      const newParent = parsed.data.parent_id;
      // Guard against loops: a tag can't be its own parent, and a parent can't
      // be one of this tag's own descendants. Walk up the proposed parent's
      // ancestry — if we reach `id`, it would create a cycle.
      if (newParent === id) {
        res.status(400).json({ error: { code: "invalid_parent", message: "A tag can't be its own parent." } });
        return;
      }
      let cursor: string | null = newParent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === id) {
          res.status(400).json({ error: { code: "invalid_parent", message: "That would create a tag loop." } });
          return;
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const anc: { parent_id: string | null } | undefined = await db
          .selectFrom("core_tags_tags").select("parent_id").where("id", "=", cursor).executeTakeFirst();
        cursor = anc?.parent_id ?? null;
      }
      patch.parent_id = newParent;
    }
    const row = await db
      .updateTable("core_tags_tags")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "tag not found" } });
      return;
    }
    res.json(row);
  }),
);

tagsRouter.delete(
  "/tags/:id",
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
      .deleteFrom("core_tags_tags")
      .where("id", "=", id)
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "tag not found" } });
      return;
    }
    await platform().events.emit("core-tags.tag.deleted", {
      orgId: ctx.org.id,
      tagId: row.id,
      name: row.name,
    });
    res.status(204).end();
  }),
);

// POST /tags/:id/merge — reassign every attachment from this tag to
// `into_tag_id`, then delete this tag. Assignments that would collide with
// an existing attachment on the target (the unique (tag_id, source_*) key)
// are dropped rather than duplicated. Idempotent-ish: a second merge 404s
// (source already gone). Consolidates accidental duplicate tags.
tagsRouter.post(
  "/tags/:id/merge",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = TagMerge.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const into = parsed.data.into_tag_id;
    if (into === id) {
      res.status(400).json({ error: { code: "merge_into_self", message: "cannot merge a tag into itself" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const [source, target] = await Promise.all([
      db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", id).executeTakeFirst(),
      db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", into).executeTakeFirst(),
    ]);
    if (!source) {
      res.status(404).json({ error: { code: "not_found", message: "source tag not found" } });
      return;
    }
    if (!target) {
      res.status(404).json({ error: { code: "target_not_found", message: "target tag not found" } });
      return;
    }

    const moved = await db.transaction().execute(async (trx) => {
      // Drop source assignments that would collide with an existing target
      // assignment on the same entity (would violate the unique key).
      await sql`
        delete from core_tags_assignments a
        where a.tag_id = ${id}
          and exists (
            select 1 from core_tags_assignments b
            where b.tag_id = ${into}
              and b.source_module = a.source_module
              and b.source_type = a.source_type
              and b.source_id = a.source_id
          )
      `.execute(trx);
      // Reassign the rest to the target.
      const upd = await trx
        .updateTable("core_tags_assignments")
        .set({ tag_id: into })
        .where("tag_id", "=", id)
        .executeTakeFirst();
      // Remove the now-empty source tag.
      await trx.deleteFrom("core_tags_tags").where("id", "=", id).execute();
      return Number(upd.numUpdatedRows ?? 0n);
    });

    await platform().events.emit("core-tags.tag.deleted", {
      orgId: ctx.org.id,
      tagId: source.id,
      name: source.name,
    });
    res.json({
      merged_into: target,
      moved_assignments: moved,
      deleted_tag: { id: source.id, name: source.name },
    });
  }),
);

// POST /attachments — attach a tag (by name or id) to a polymorphic
// entity. Idempotent on (tag, entity) — re-attach returns the same row.
tagsRouter.post(
  "/attachments",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AttachBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // Resolve to a tag id — create on the fly if attach-by-name and
    // no such tag exists yet.
    let tagId = parsed.data.tag_id ?? null;
    if (!tagId && parsed.data.tag_name) {
      const trimmed = parsed.data.tag_name.trim();
      const existing = await db
        .selectFrom("core_tags_tags")
        .select("id")
        .where(sql`lower(name)`, "=", trimmed.toLowerCase())
        .executeTakeFirst();
      tagId =
        existing?.id ??
        (
          await db
            .insertInto("core_tags_tags")
            .values({ name: trimmed, color: parsed.data.color ?? null })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;
    }
    if (!tagId) {
      res.status(400).json({
        error: { code: "tag_required", message: "tag_name or tag_id required" },
      });
      return;
    }

    // Idempotent on (tag, entity).
    const existing = await db
      .selectFrom("core_tags_assignments")
      .selectAll()
      .where("tag_id", "=", tagId)
      .where("source_module", "=", parsed.data.source_module)
      .where("source_type", "=", parsed.data.source_type)
      .where("source_id", "=", parsed.data.source_id)
      .executeTakeFirst();
    if (existing) {
      res.json(existing);
      return;
    }
    const row = await db
      .insertInto("core_tags_assignments")
      .values({
        tag_id: tagId,
        source_module: parsed.data.source_module,
        source_type: parsed.data.source_type,
        source_id: parsed.data.source_id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("core-tags.assignment.created", {
      orgId: ctx.org.id,
      tagId,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
    });
    res.status(201).json(row);
  }),
);

// GET /attachments?source_type=&source_id= — list tags on an entity.
tagsRouter.get(
  "/attachments",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const sourceType = typeof req.query.source_type === "string" ? req.query.source_type : null;
    const sourceId = typeof req.query.source_id === "string" ? req.query.source_id : null;
    const tagId = typeof req.query.tag_id === "string" ? req.query.tag_id : null;
    if (!sourceType && !sourceId && !tagId) {
      res.status(400).json({
        error: {
          code: "missing_filter",
          message: "filter by source_type+source_id OR tag_id required",
        },
      });
      return;
    }
    let q = db
      .selectFrom("core_tags_assignments as a")
      .innerJoin("core_tags_tags as t", "t.id", "a.tag_id")
      .select([
        "a.id as id",
        "a.tag_id as tag_id",
        "a.source_module as source_module",
        "a.source_type as source_type",
        "a.source_id as source_id",
        "t.name as tag_name",
        "t.color as tag_color",
        "a.created_at as created_at",
      ])
      .orderBy("t.name");
    if (sourceType) q = q.where("a.source_type", "=", sourceType);
    if (sourceId) q = q.where("a.source_id", "=", sourceId);
    if (tagId) q = q.where("a.tag_id", "=", tagId);
    const items = await q.execute();
    res.json({ items });
  }),
);

tagsRouter.delete(
  "/attachments/:id",
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
      .deleteFrom("core_tags_assignments")
      .where("id", "=", id)
      .returning(["id", "tag_id", "source_module", "source_type", "source_id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "attachment not found" } });
      return;
    }
    await platform().events.emit("core-tags.assignment.deleted", {
      orgId: ctx.org.id,
      tagId: row.tag_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
    });
    res.status(204).end();
  }),
);
