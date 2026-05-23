// /attachments — polymorphic "this file is the X of that entity".
//
// One row per (file, entity, role). role is open-ended free text;
// common values: 'hero', 'avatar', 'gallery'. NULL role means "primary
// attachment". For galleries (>1 file per entity with same role), use
// role='gallery' and rely on sort_order for ordering.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const attachmentsRouter = Router({ mergeParams: true });

const AttachmentCreate = z.object({
  file_id: z.string().uuid(),
  source_module: z.string().min(1).max(80),
  source_type: z.string().min(1).max(80),
  source_id: z.string().uuid(),
  role: z.string().min(1).max(40).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
});

attachmentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = AttachmentCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // Verify the referenced file exists and isn't soft-deleted.
    const file = await db
      .selectFrom("core_files_files")
      .select("id")
      .where("id", "=", parsed.data.file_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!file) {
      res.status(404).json({
        error: { code: "file_not_found", message: "no such file" },
      });
      return;
    }

    try {
      const row = await db
        .insertInto("core_files_attachments")
        .values({
          file_id: parsed.data.file_id,
          source_module: parsed.data.source_module,
          source_type: parsed.data.source_type,
          source_id: parsed.data.source_id,
          role: parsed.data.role ?? null,
          sort_order: parsed.data.sort_order ?? 0,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await platform().events.emit("core-files.attachment.created", {
        orgId: ctx.org.id,
        attachmentId: row.id,
        fileId: row.file_id,
        source_module: row.source_module,
        source_type: row.source_type,
        source_id: row.source_id,
        role: row.role,
      });
      res.status(201).json(row);
    } catch (err) {
      // Unique violation = already attached with that role.
      if (
        typeof err === "object" &&
        err &&
        (err as { code?: string }).code === "23505"
      ) {
        res.status(409).json({
          error: {
            code: "already_attached",
            message: "This file is already attached to that entity with that role.",
          },
        });
        return;
      }
      throw err;
    }
  }),
);

attachmentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    // List by entity is the most common query — require both type
    // and id, or all three (module + type + id).
    const sourceModule = typeof req.query.source_module === "string" ? req.query.source_module : null;
    const sourceType = typeof req.query.source_type === "string" ? req.query.source_type : null;
    const sourceId = typeof req.query.source_id === "string" ? req.query.source_id : null;
    if (!sourceType || !sourceId) {
      res.status(400).json({
        error: {
          code: "missing_filter",
          message: "?source_type=...&source_id=... required (source_module optional)",
        },
      });
      return;
    }
    let q = db
      .selectFrom("core_files_attachments as fa")
      .innerJoin("core_files_files as f", "f.id", "fa.file_id")
      .select([
        "fa.id as id",
        "fa.file_id as file_id",
        "fa.source_module as source_module",
        "fa.source_type as source_type",
        "fa.source_id as source_id",
        "fa.role as role",
        "fa.sort_order as sort_order",
        "fa.created_at as created_at",
        "f.filename as filename",
        "f.mime_type as mime_type",
        "f.kind as kind",
        "f.width as width",
        "f.height as height",
        "f.size_bytes as size_bytes",
        "f.variants as variants",
      ])
      .where("fa.source_type", "=", sourceType)
      .where("fa.source_id", "=", sourceId)
      .where("f.deleted_at", "is", null)
      .orderBy("fa.sort_order", "asc")
      .orderBy("fa.created_at", "asc");
    if (sourceModule) q = q.where("fa.source_module", "=", sourceModule);
    const items = await q.execute();
    res.json({
      items: items.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) })),
    });
  }),
);

attachmentsRouter.delete(
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
      .deleteFrom("core_files_attachments")
      .where("id", "=", id)
      .returning(["id", "file_id", "source_module", "source_type", "source_id", "role"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "attachment not found" } });
      return;
    }
    await platform().events.emit("core-files.attachment.deleted", {
      orgId: ctx.org.id,
      attachmentId: row.id,
      fileId: row.file_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
      role: row.role,
    });
    res.status(204).end();
  }),
);
