// /files — upload, list, get, delete, serve.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import type { FileVariants } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { readVariant, removeStoredFile, storeUpload } from "./storage.js";

export const filesRouter = Router({ mergeParams: true });

// 25MB ceiling per file. Generous for photos, doesn't try to also be
// a cloud-storage backend.
const MAX_BYTES = 25 * 1024 * 1024;

// In-memory buffer (multer.memoryStorage) — we re-encode + write
// derived variants anyway, so streaming straight to disk wouldn't
// save much, and keeping the buffer in hand simplifies sharp.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

// D5 attach-shortcut. POST /files accepts optional fields that, when
// present, also create a core_files_attachments row in the same
// request — closing the "upload then attach" round-trip that every
// entity-detail UI was doing. Either pass all three (module + type +
// id) or none; partial → 400 before any disk write.
//
// Pass via multipart form fields (alongside the file) OR via query
// string — both work because multer hoists form fields onto req.body
// and Express parses the query string anyway.
//
// Naming: keep them snake_case to match the rest of the API and the
// /attachments POST body. `attach_role` defaults to null = primary.
filesRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file || !file.buffer) {
      res.status(400).json({
        error: { code: "missing_file", message: "Multipart field 'file' is required." },
      });
      return;
    }

    // Read attach-shortcut fields from body (multer-hoisted) OR
    // query string. Both supported; body wins on collision.
    const readField = (k: string): string | null => {
      const fromBody = (req.body as Record<string, unknown> | undefined)?.[k];
      if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
      const fromQuery = req.query[k];
      if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;
      return null;
    };
    const attachModule = readField("attach_module");
    const attachType = readField("attach_type");
    const attachId = readField("attach_id");
    const attachRole = readField("attach_role");
    const wantsAttach = attachModule || attachType || attachId;
    if (wantsAttach && !(attachModule && attachType && attachId)) {
      res.status(400).json({
        error: {
          code: "incomplete_attach",
          message:
            "attach_module + attach_type + attach_id must all be supplied together.",
        },
      });
      return;
    }
    if (attachId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachId)) {
      res.status(400).json({
        error: { code: "bad_attach_id", message: "attach_id must be a UUID." },
      });
      return;
    }

    // We pre-generate the id so storeUpload knows the target dir
    // before the DB insert. If the insert fails we clean up the disk
    // bytes — see catch below.
    const fileId = randomUUID();
    let stored;
    try {
      stored = await storeUpload(
        ctx.org.id,
        fileId,
        file.buffer,
        file.mimetype || "application/octet-stream",
      );
    } catch (err) {
      console.error(`[core-files] storeUpload failed for ${fileId}:`, err);
      res.status(500).json({
        error: { code: "store_failed", message: "Failed to write file to disk." },
      });
      return;
    }

    try {
      const db = tenantDb(req);
      const row = await db
        .insertInto("core_files_files")
        .values({
          id: fileId,
          org_id: ctx.org.id,
          owner_user_id: session?.id ?? null,
          filename: file.originalname || "untitled",
          mime_type: stored.mime_type,
          size_bytes: String(stored.size_bytes),
          sha256: stored.sha256,
          variants: stored.variants,
          kind: stored.kind,
          width: stored.width,
          height: stored.height,
        })
        .returning(["id", "filename", "mime_type", "kind", "width", "height", "created_at"])
        .executeTakeFirstOrThrow();

      await platform().events.emit("core-files.file.uploaded", {
        orgId: ctx.org.id,
        fileId: row.id,
        kind: stored.kind,
        size_bytes: stored.size_bytes,
      });

      // Best-effort attach if requested. If the attach row fails we
      // still return the file (so the user has the upload), with the
      // attachment_error explaining what went wrong.
      let attachment:
        | { id: string; source_module: string; source_type: string; source_id: string; role: string | null }
        | null = null;
      let attachmentError: string | null = null;
      if (attachModule && attachType && attachId) {
        try {
          const aRow = await db
            .insertInto("core_files_attachments")
            .values({
              file_id: fileId,
              source_module: attachModule,
              source_type: attachType,
              source_id: attachId,
              role: attachRole ?? null,
              sort_order: 0,
            })
            .returning(["id", "source_module", "source_type", "source_id", "role"])
            .executeTakeFirstOrThrow();
          attachment = aRow;
          await platform().events.emit("core-files.attachment.created", {
            orgId: ctx.org.id,
            attachmentId: aRow.id,
            fileId,
            source_module: aRow.source_module,
            source_type: aRow.source_type,
            source_id: aRow.source_id,
            role: aRow.role,
          });
        } catch (err) {
          if (
            typeof err === "object" &&
            err &&
            (err as { code?: string }).code === "23505"
          ) {
            attachmentError = "already_attached";
          } else {
            console.error("[core-files] inline attach failed:", err);
            attachmentError = "attach_failed";
          }
        }
      }

      res.status(201).json({
        ...row,
        size_bytes: stored.size_bytes,
        sha256: stored.sha256,
        variants: stored.variants,
        attachment,
        attachment_error: attachmentError,
      });
    } catch (err) {
      await removeStoredFile(ctx.org.id, fileId).catch(() => {});
      throw err;
    }
  }),
);

filesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    let q = db
      .selectFrom("core_files_files")
      .select([
        "id",
        "filename",
        "mime_type",
        "size_bytes",
        "kind",
        "width",
        "height",
        "variants",
        "created_at",
      ])
      .where("deleted_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(limit);
    if (kind) q = q.where("kind", "=", kind as never);
    const items = await q.execute();
    res.json({
      items: items.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) })),
    });
  }),
);

filesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_files_files")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "file not found" } });
      return;
    }
    res.json({ ...row, size_bytes: Number(row.size_bytes) });
  }),
);

// Combined raw + variant-shortcut route.
//   /files/:id/raw             → original
//   /files/:id/raw?variant=med → medium (alias: m, medium)
//   /files/:id/raw?variant=t   → thumb (alias: t, thumb, thumbnail)
filesRouter.get(
  "/:id/raw",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const which = pickVariant(typeof req.query.variant === "string" ? req.query.variant : null);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_files_files")
      .select(["id", "mime_type", "filename", "variants", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) {
      res.status(404).json({ error: { code: "not_found", message: "file not found" } });
      return;
    }
    const variants = row.variants as FileVariants;
    const resolved = await readVariant(ctx.org.id, id, variants, which);
    if (!resolved) {
      // Fall back to original if a derived variant is missing.
      if (which !== "original") {
        const fallback = await readVariant(ctx.org.id, id, variants, "original");
        if (fallback) {
          res.type(row.mime_type || "application/octet-stream");
          res.sendFile(fallback.path);
          return;
        }
      }
      res.status(404).json({
        error: { code: "variant_missing", message: `variant '${which}' not on disk` },
      });
      return;
    }
    // Variants are always JPEG for images; original keeps its source mime.
    const variantMime =
      which === "original" ? row.mime_type || "application/octet-stream" : "image/jpeg";
    res.type(variantMime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(resolved.path);
  }),
);

filesRouter.delete(
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
    const updated = await db
      .updateTable("core_files_files")
      .set({ deleted_at: new Date() })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "file not found" } });
      return;
    }
    await platform().events.emit("core-files.file.deleted", {
      orgId: ctx.org.id,
      fileId: id,
    });
    res.status(204).end();
  }),
);

function pickVariant(raw: string | null): "original" | "medium" | "thumb" {
  if (!raw) return "original";
  const v = raw.toLowerCase();
  if (v === "m" || v === "med" || v === "medium") return "medium";
  if (v === "t" || v === "thumb" || v === "thumbnail") return "thumb";
  return "original";
}
