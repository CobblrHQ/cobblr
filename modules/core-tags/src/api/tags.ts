// /tags — tag CRUD. /assignments — polymorphic attach/detach + list.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireCapability, requireRole } from "./util.js";
import { TagRestoreRefused, deleteTagKept, mergeTagKept, restoreTag } from "../tag-writes.js";
import { isQuiet, quietReason, rankTags, type TagUsage } from "../relevance.js";
import { attachTag, createTag, detachTag, ensureTag, TagNameTaken, updateTag, type Writer } from "../tag-writes.js";

const writer = (req: Parameters<typeof tenantContext>[0]): Writer => ({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null });

/** A name another tag already has: 409 with that tag, never a 500. */
function nameTaken(res: import("express").Response, err: TagNameTaken): void {
  res.status(409).json({ error: { code: "tag_exists", message: `A tag called "${err.existing.name}" already exists.` }, tag: err.existing });
}

export const tagsRouter = Router({ mergeParams: true });

const TagCreate = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(40).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  icon: z.string().max(16).nullable().optional(),
});

// `pinned` is update-only on purpose: you pin a tag you already have and can
// see the ranking of, never one you are in the middle of typing.
const TagUpdate = TagCreate.partial().extend({ pinned: z.boolean().optional(), metadata: z.record(z.unknown()).optional() });

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
    try {
      res.status(201).json(await createTag(tenantDb(req), writer(req), parsed.data));
    } catch (err) {
      if (err instanceof TagNameTaken) return nameTaken(res, err);
      throw err;
    }
  }),
);

/** Usage stats per tag, for ranking. One grouped read of the assignment table.
 *
 *  Shared deliberately: the tag PICKER, a record's chip row and the /tags page
 *  all order by relevance, and three separate queries would drift into three
 *  different orders for the same tags. */
async function usageByTag(db: ReturnType<typeof tenantDb>): Promise<Map<string, TagUsage>> {
  const rows = await db
    .selectFrom("core_tags_tags as t")
    .leftJoin("core_tags_assignments as a", "a.tag_id", "t.id")
    .select(({ fn }) => [
      "t.id as id",
      "t.name as name",
      "t.pinned as pinned",
      fn.count<number>("a.id").as("uses"),
      fn.max("a.created_at").as("last_used_at"),
      fn.min("a.created_at").as("first_used_at"),
    ])
    .groupBy(["t.id", "t.name", "t.pinned"])
    .execute();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        // count() comes back as a string from pg for bigint columns.
        uses: Number(r.uses ?? 0),
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at as unknown as string) : null,
        firstUsedAt: r.first_used_at ? new Date(r.first_used_at as unknown as string) : null,
        pinned: !!r.pinned,
      },
    ]),
  );
}

tagsRouter.get(
  "/tags",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db.selectFrom("core_tags_tags").selectAll().execute();
    const usage = await usageByTag(db);
    const now = new Date();
    // Relevance, not the alphabet. Alphabetical order put "3DPrintopia 2026"
    // above "in service" on every printer forever, purely because it starts
    // with a digit.
    const decorated = rows.map((t) => {
      const u = usage.get(t.id) ?? {
        id: t.id, name: t.name, uses: 0, lastUsedAt: null, firstUsedAt: null, pinned: !!t.pinned,
      };
      return { ...t, uses: u.uses, last_used_at: u.lastUsedAt, quiet: isQuiet(u, now) };
    });
    const order = new Map(rankTags([...usage.values()], now).map((u, i) => [u.id, i]));
    decorated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    res.json({ items: decorated });
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
    if (parsed.data.pinned !== undefined) patch.pinned = parsed.data.pinned;
    // A custom field saved on its own merges into what the tag holds.
    if (parsed.data.metadata !== undefined) patch.metadata = platform().db.mergeJsonb("metadata", parsed.data.metadata);
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
    delete patch.updated_at;
    let row;
    try {
      row = await updateTag(db, writer(req), id, patch);
    } catch (err) {
      if (err instanceof TagNameTaken) return nameTaken(res, err);
      throw err;
    }
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "tag not found" } });
      return;
    }
    res.json(row);
  }),
);

// A tag's delete takes it off every record that carries it, across the
// workspace, so it is an owner's or admin's call (or a grant of
// core-tags:delete-tag); a member is told so and can ask. What it took is
// kept, so it can be put back (tag-writes.ts).
tagsRouter.delete(
  "/tags/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    if (!(await requireCapability(req, res, "core-tags:delete-tag"))) return;
    const gone = await deleteTagKept(tenantDb(req), tenantContext(req).org.id, id, sessionUser(req)?.id ?? null);
    if (!gone) {
      res.status(404).json({ error: { code: "not_found", message: "tag not found" } });
      return;
    }
    res.json({ deleted: true, name: gone.name, assignments: gone.assignments, undo: { restore: `tags/deleted/${id}/restore` } });
  }),
);

// POST /tags/:id/merge — reassign every attachment from this tag to
// `into_tag_id`, then delete this tag. Assignments that would collide with
// an existing attachment on the target (the unique (tag_id, source_*) key)
// are dropped rather than duplicated. Like a delete it reaches every record
// carrying the tag, so it needs the merge capability (owner or admin, or a
// grant), and what it moved is kept so it can be put back.
// AI-ACTION: core-tags:merge
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
    if (!(await requireCapability(req, res, "core-tags:merge"))) return;
    const db = tenantDb(req);
    const target = await db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", into).executeTakeFirst();
    if (!target) {
      res.status(404).json({ error: { code: "target_not_found", message: "target tag not found" } });
      return;
    }
    const merged = await mergeTagKept(db, tenantContext(req).org.id, id, into, sessionUser(req)?.id ?? null);
    if (!merged) {
      res.status(404).json({ error: { code: "not_found", message: "source tag not found" } });
      return;
    }
    res.json({
      merged_into: target,
      moved_assignments: merged.moved,
      deleted_tag: { id, name: merged.name },
      undo: { restore: `tags/deleted/${id}/restore` },
    });
  }),
);

// Undo a tag delete or merge: the tag under its own id, back on every record
// that carried it. Putting a tag back is never the dangerous direction, so
// anyone who can tag may.
// AI-ACTION: core-tags:restore-tag
// AI-REACH: action core-tags:restore-tag (the page's Undo; the assistant also
// undoes a delete through its ledger and the tag writer's restore)
tagsRouter.post(
  "/tags/deleted/:id/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    try {
      const back = await restoreTag(tenantDb(req), tenantContext(req).org.id, req.params.id!, sessionUser(req)?.id ?? null);
      if (!back) {
        res.status(404).json({ error: { code: "not_found", message: "That tag was not deleted recently enough to put back." } });
        return;
      }
      res.json({ restored: true, ...back });
    } catch (e) {
      if (!(e instanceof TagRestoreRefused)) throw e;
      res.status(409).json({ error: { code: "name_taken", message: e.message } });
    }
  }),
);

// POST /attachments — attach a tag (by name or id) to a polymorphic
// entity. Idempotent on (tag, entity) — re-attach returns the same row.
// AI-ACTION: core-tags:tag-record
tagsRouter.post(
  "/attachments",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AttachBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);

    // Attach by name makes the tag when there is none yet.
    const w = writer(req);
    const tag = parsed.data.tag_id
      ? await db.selectFrom("core_tags_tags").select(["id", "name"]).where("id", "=", parsed.data.tag_id).executeTakeFirst()
      : await ensureTag(db, w, parsed.data.tag_name!, parsed.data.color ?? null);
    if (!tag) {
      res.status(404).json({ error: { code: "tag_not_found", message: "no such tag" } });
      return;
    }
    const { row, created } = await attachTag(db, w, tag, {
      source_module: parsed.data.source_module,
      source_type: parsed.data.source_type,
      source_id: parsed.data.source_id,
    });
    res.status(created ? 201 : 200).json(row);
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
    const rows = await q.execute();
    // Ranked here rather than in the browser, so the chip row, the picker and
    // the /tags page cannot disagree about which tags matter.
    const usage = await usageByTag(db);
    const now = new Date();
    const seen = rows.map((r) => usage.get(r.tag_id)).filter((u): u is TagUsage => !!u);
    const order = new Map(rankTags(seen, now).map((u, i) => [u.id, i]));
    const items = rows
      .map((r) => {
        const u = usage.get(r.tag_id);
        return {
          ...r,
          uses: u?.uses ?? 0,
          last_used_at: u?.lastUsedAt ?? null,
          pinned: u?.pinned ?? false,
          // Fold behind "+N" on a stated ground — old AND narrow — never on a
          // score, because a hidden thing needs a reason a person can read.
          quiet: u ? isQuiet(u, now) : false,
          quiet_reason: u && isQuiet(u, now) ? quietReason(u, now) : null,
        };
      })
      .sort((a, b) => (order.get(a.tag_id) ?? 0) - (order.get(b.tag_id) ?? 0));
    res.json({ items });
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
tagsRouter.delete(
  "/attachments/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const row = await detachTag(tenantDb(req), writer(req), { id });
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "attachment not found" } });
      return;
    }
    res.status(204).end();
  }),
);
