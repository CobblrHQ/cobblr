// /files — upload, list, get, delete, serve.

import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import type { CoreFilesDB, FileKind, FileVariants } from "../db.js";
import type { SelectQueryBuilder } from "kysely";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { readVariant, readVariantBytes } from "./storage.js";
import { intakeFile, resolveTarget, sameBytes } from "./intake.js";
import { bytesUsed, QUOTA_BYTES, quotaDecision } from "./quota.js";

export const filesRouter = Router({ mergeParams: true });

// 25MB ceiling per file. Generous for photos, doesn't try to also be
// a cloud-storage backend.
const MAX_BYTES = 25 * 1024 * 1024;

// Mime types safe to serve inline from our own origin. Non-scriptable raster
// images only — SVG is deliberately excluded (it can carry <script>), as is
// every document/text type. Anything not on this list downloads as an
// attachment so a malicious upload can't execute same-origin. See
// docs/history/2026-06-10-prelaunch-audit.md #4.
const INLINE_SAFE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

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
// AI-REACH: takes or produces a file (multipart or binary), which an action cannot carry
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

    // Entitlement gate for a USER upload. A hosted tier may withhold user file
    // uploads — the trial tier does (its anti-hosting rule: never store bytes the
    // user chose; scan images arrive only via the server-side fetch, which stores
    // with platform().files.write and never hits this route). No-op in open core /
    // self-host (no guard registered) and on paid plans (the overlay allows it —
    // files.upload has no configured limit, so it returns allow).
    // The running total, for the plan's guard and the workspace's quota.
    const used = await bytesUsed(tenantDb(req));
    const ent = await platform().entitlements.check({
      orgId: ctx.org.id,
      feature: "files.upload",
      userId: session?.id,
      quantity: file.buffer.length,
      used,
    });
    if (!ent.allow) {
      res.status(402).json({
        error: { code: "plan_limit", message: ent.reason ?? "File uploads aren't available on your plan." },
      });
      return;
    }
    const room = quotaDecision(used, file.buffer.length, QUOTA_BYTES);
    if (!room.allow) {
      res.status(413).json({ error: { code: "storage_full", message: room.reason } });
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

    // Where it goes: a folder, or the top level. A folder that has gone
    // since the page loaded is said, never silently swapped for the top.
    // `folder_path` ("Patterns/Blankets") is made where missing, under
    // `folder_id` when both are given.
    const db0 = tenantDb(req);
    const resolved = await resolveTarget(db0, readField("folder_id"), readField("folder_path"));
    if (resolved === "missing") {
      res.status(404).json({ error: { code: "folder_not_found", message: "That folder does not exist any more." } });
      return;
    }
    const folderId = resolved;
    // The same bytes already here: say which file, and with
    // on_duplicate=skip keep the one copy instead of storing a second
    // (a re-imported download folder, a pattern bought twice).
    const same = await sameBytes(db0, file.buffer);
    if (same && readField("on_duplicate") === "skip") {
      res.status(200).json({ ...same, size_bytes: Number(same.size_bytes), duplicate: true, duplicate_of: { id: same.id, filename: same.filename, folder_id: same.folder_id, folder_names: same.folder_names } });
      return;
    }

    let taken;
    try {
      taken = await intakeFile(db0, ctx.org.id, session?.id ?? null, {
        buffer: file.buffer,
        filename: file.originalname || "untitled",
        mime: file.mimetype || "application/octet-stream",
        folderId,
      });
    } catch (err) {
      console.error("[core-files] storing an upload failed:", err);
      res.status(500).json({ error: { code: "store_failed", message: "Failed to store the file." } });
      return;
    }
    const { row, stored } = taken;
    const fileId = row.id;

    // Best-effort attach if requested. If the attach row fails we
    // still return the file (so the user has the upload), with the
    // attachment_error explaining what went wrong.
    let attachment:
      | { id: string; source_module: string; source_type: string; source_id: string; role: string | null }
      | null = null;
    let attachmentError: string | null = null;
    if (attachModule && attachType && attachId) {
      try {
        const aRow = await db0
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
        if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
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
      duplicate: false,
      duplicate_of: same ? { id: same.id, filename: same.filename, folder_id: same.folder_id, folder_names: same.folder_names } : null,
    });
  }),
);

filesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    // `folder=top` is the top level; a folder id is that folder; absent is
    // every file wherever it lives. `q` matches the name.
    const folder = typeof req.query.folder === "string" ? req.query.folder : null;
    const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
    // Keyset pagination (docs/design-decisions/list-pagination.md): the
    // cursor is the last row's created_at and id, newest first.
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
    const [cursorAt, cursorId] = cursor.split("|");
    const cursorDate = cursorAt ? new Date(cursorAt) : null;
    const filtered = <O,>(qb: SelectQueryBuilder<CoreFilesDB, "core_files_files", O>) => {
      let out = qb.where("deleted_at", "is", null);
      if (kind) out = out.where("kind", "=", kind as FileKind);
      if (folder === "top") out = out.where("folder_id", "is", null);
      else if (folder && /^[0-9a-f-]{36}$/i.test(folder)) out = out.where("folder_id", "=", folder);
      if (text) out = out.where("filename", "ilike", `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      return out;
    };
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
        "folder_id",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    q = filtered(q);
    if (cursorDate && !Number.isNaN(cursorDate.getTime()) && cursorId) {
      q = q.where((eb) => eb.or([eb("created_at", "<", cursorDate), eb.and([eb("created_at", "=", cursorDate), eb("id", "<", cursorId)])]));
    }
    const rows = await q.execute();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const counted = await filtered(db.selectFrom("core_files_files").select(db.fn.countAll<string>().as("n"))).executeTakeFirst();
    const items = await platform().entities.withFieldLabels(
      tenantContext(req).org.id,
      "core-files:file",
      page.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) })),
    );
    res.json({
      items,
      next_cursor: rows.length > limit && last ? `${new Date(last.created_at).toISOString()}|${last.id}` : null,
      total: Number(counted?.n ?? 0),
    });
  }),
);

// What the workspace keeps, and how much it may: the Files page's
// "1.2 GB of 10 GB". `quota_bytes` is null when there is no limit.
filesRouter.get(
  "/usage",
  asyncHandler(async (req, res) => {
    res.json({ bytes_used: await bytesUsed(tenantDb(req)), quota_bytes: QUOTA_BYTES });
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
    const [labelled] = await platform().entities.withFieldLabels(tenantContext(req).org.id, "core-files:file", [{ ...row, size_bytes: Number(row.size_bytes) }]);
    res.json(labelled);
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
    // Resolve the requested variant, falling back to the original if a derived
    // one is gone.
    let served: "original" | "medium" | "thumb" = which;
    let resolved = await readVariant(ctx.org.id, id, variants, which);
    if (!resolved && which !== "original") {
      served = "original";
      resolved = await readVariant(ctx.org.id, id, variants, "original");
    }
    if (!resolved) {
      res.status(404).json({
        error: { code: "variant_missing", message: `variant '${which}' not available` },
      });
      return;
    }
    // Variants are always JPEG for images; original keeps its source mime.
    const rawMime = served === "original" ? row.mime_type || "application/octet-stream" : "image/jpeg";
    // Stored mime_type is attacker-controlled (taken from the upload's
    // Content-Type). Serving an SVG/HTML original inline runs it same-origin →
    // reads the localStorage JWT. Only render a short allowlist of non-scriptable
    // raster types inline; force everything else to download as octet-stream.
    const inline = INLINE_SAFE_MIME.has(rawMime.toLowerCase());
    const variantMime = inline ? rawMime : "application/octet-stream";
    res.type(variantMime);
    if (!inline) {
      const safeName = String(row.filename || "download").replace(/[^A-Za-z0-9._-]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (resolved.localPath) {
      res.sendFile(resolved.localPath); // local driver — fast path
    } else {
      // Remote driver (S3/R2) — stream the bytes through.
      const bytes = await readVariantBytes(ctx.org.id, id, variants, served);
      if (!bytes) {
        res.status(404).json({ error: { code: "variant_missing", message: "not found" } });
        return;
      }
      res.send(bytes);
    }
  }),
);

// Rename and move. The bytes never change; only the name a person knows
// the file by and the folder it lives in.
// AI-REACH: crud — the core-files:file kind's update endpoint (filename, folder_id)
const FilePatch = z
  .object({ filename: z.string().trim().min(1).max(255).optional(), folder_id: z.string().uuid().nullable().optional() })
  .refine((b) => b.filename !== undefined || b.folder_id !== undefined, "filename or folder_id");
filesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const id = req.params.id!;
    const parsed = FilePatch.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const to = parsed.data.folder_id;
    if (to && !(await db.selectFrom("core_files_folders").select("id").where("id", "=", to).executeTakeFirst())) {
      res.status(404).json({ error: { code: "folder_not_found", message: "That folder does not exist any more." } });
      return;
    }
    const row = await db
      .updateTable("core_files_files")
      .set({ ...(parsed.data.filename !== undefined ? { filename: parsed.data.filename } : {}), ...(to !== undefined ? { folder_id: to } : {}) })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .returning(["id", "filename", "folder_id", "mime_type", "kind", "size_bytes", "created_at"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "file not found" } });
      return;
    }
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "file_updated",
      ref: { module: "core-files", entityType: "file", entityId: id },
      diff: { ...(parsed.data.filename !== undefined ? { name: parsed.data.filename } : {}), ...(to !== undefined ? { folder_id: to } : {}) },
    });
    res.json({ ...row, size_bytes: Number(row.size_bytes) });
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
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "file_deleted",
      ref: { module: "core-files", entityType: "file", entityId: id },
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
