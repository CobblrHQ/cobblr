import { readListPage, pagedAnswer, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { canPurgeDeletedRecord } from "@cobblr/platform-contract";
// /files — upload, list, get, delete, serve.

import { notePhotoSource } from "./photo-source.js";
import { Router } from "express";
import { z } from "zod";
import { likeEscape, platform, uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import type { CoreFilesDB, FileKind, FileVariants } from "../db.js";
import { sql, type SelectQueryBuilder } from "kysely";
import { decodeKeysetCursor, encodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { classifyKind, headOfPath, readVariant, readVariantBytes } from "./storage.js";
import { sniffType } from "@cobblr/platform-contract/sniff-type";
import { intakeFile, resolveTarget, sameBytes } from "./intake.js";
import { bytesUsed, QUOTA_BYTES, quotaDecision } from "./quota.js";
import { purgeAfter, purgeFile, restoreFile, RECENTLY_DELETED_DAYS } from "../purge.js";

export const filesRouter = Router({ mergeParams: true });

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

// Through the platform's one upload door: streamed to disk and hashed as it
// arrives, each file's limit by its kind (PDFs and design files 200 MB,
// everything else 25 MB), a file over it answered 413 with its size and the
// limit. The stored original is linked in from there, never read whole.
const upload = uploadOne({});

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
  upload,
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const file = uploadedFile(req);
    if (!file) {
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
      quantity: file.size,
      used,
    });
    if (!ent.allow) {
      const message = ent.reason ?? "File uploads aren't available on your plan.";
      platform().http.uploadRefused(req, { reason: "plan_limit", sizeBytes: file.size, mimeType: file.mimetype, message });
      res.status(402).json({ error: { code: "plan_limit", message } });
      return;
    }
    const room = quotaDecision(used, file.size, QUOTA_BYTES);
    if (!room.allow) {
      platform().http.uploadRefused(req, { reason: "storage_full", sizeBytes: file.size, limitBytes: QUOTA_BYTES, mimeType: file.mimetype, message: room.reason ?? "This workspace's storage is full." });
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
    const fingerprint = { sha256: file.sha256, size: file.size };
    const same = await sameBytes(db0, fingerprint);
    if (same && readField("on_duplicate") === "skip") {
      res.status(200).json({ ...same, size_bytes: Number(same.size_bytes), duplicate: true, duplicate_of: { id: same.id, filename: same.filename, folder_id: same.folder_id, folder_names: same.folder_names } });
      return;
    }

    let taken;
    try {
      taken = await intakeFile(db0, ctx.org.id, session?.id ?? null, {
        source: { path: file.path, size: file.size, sha256: file.sha256 },
        fingerprint,
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
    // A person's own picture: taken with the camera, or chosen from the
    // device. Said by the page that sent it; anything else is "upload".
    if (stored.kind === "image") {
      await notePhotoSource(db0, fileId, { kind: readField("photo_source") === "camera" ? "camera" : "upload", at: new Date().toISOString() });
    }

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
    // To the millisecond, the precision the cursor carries
    // (@cobblr/platform-contract/keyset-cursor).
    const c = decodeKeysetCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
    const filtered = <O,>(qb: SelectQueryBuilder<CoreFilesDB, "core_files_files", O>) => {
      // A copy that repeats another file's bytes is listed as that file (#3859).
      let out = qb.where("deleted_at", "is", null).where("same_as", "is", null);
      if (kind) out = out.where("kind", "=", kind as FileKind);
      if (folder === "top") out = out.where("folder_id", "is", null);
      else if (folder && /^[0-9a-f-]{36}$/i.test(folder)) out = out.where("folder_id", "=", folder);
      if (text) out = out.where("filename", "ilike", `%${likeEscape(text)}%`);
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
      .orderBy(sql`date_trunc('milliseconds', created_at)`, "desc")
      .orderBy("id", "desc")
      .limit(limit + 1);
    q = filtered(q);
    if (c?.id && /^[0-9a-f-]{36}$/i.test(c.id)) {
      q = q.where(sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${c.at}, ${c.id}::uuid)`);
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
      next_cursor: rows.length > limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
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

// Recently deleted: what was deleted in the last RECENTLY_DELETED_DAYS, newest
// first, each with the moment it goes for good. A same-bytes copy is left out,
// as it is from every list.
filesRouter.get(
  "/deleted",
  asyncHandler(async (req, res) => {
    const page = readListPage(req.query);
    const rows = await tenantDb(req)
      .selectFrom("core_files_files")
      .select(["id", "filename", "mime_type", "size_bytes", "kind", "variants", "deleted_at", "created_at"])
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .where("deleted_at", "is not", null)
      .where("same_as", "is", null)
      .orderBy("deleted_at", "desc")
      .orderBy("id", "desc")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const answer = pagedAnswer(rows, page);
    res.json({
      ...answer,
      days: RECENTLY_DELETED_DAYS,
      items: answer.items.map((r) => ({
        ...r,
        size_bytes: Number(r.size_bytes),
        purge_after: purgeAfter(r.deleted_at as Date).toISOString(),
      })),
    });
  }),
);

// Bring a deleted file back, where it was (restoreFile, shared with the
// core-files:restore action).
// AI-REACH: action core-files:restore
filesRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id!;
    const ctx = tenantContext(req);
    const r = await restoreFile(tenantDb(req), ctx.org.id, id);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 413).json({ error: { code: r.code, message: r.message } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "file_restored",
      ref: { module: "core-files", entityType: "file", entityId: id },
    });
    res.json({ ok: true });
  }),
);

// Delete forever now: a file already in Recently deleted goes at once, bytes
// and all, instead of waiting out its days.
// AI-REACH: exempt irreversible by design; a person does it from Recently deleted, and a deleted file goes by itself after its days
filesRouter.delete(
  "/:id/forever",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id!;
    const ctx = tenantContext(req);
    const kept = await platform().deletedRecords.get(ctx.org.id, "core-files:file", id);
    if (!canPurgeDeletedRecord(ctx.role, kept?.deletedBy ?? null, sessionUser(req)?.id ?? "")) {
      res.status(403).json({ error: { code: "purge_refused", message: "Only the person who deleted this file or a workspace admin can delete it forever." } });
      return;
    }
    const gone = await purgeFile(tenantDb(req), ctx.org.id, id);
    if (!gone) {
      res.status(409).json({
        error: {
          code: "not_purgeable",
          message: "Only a file in Recently deleted can be deleted forever, and not while a copy of it is still in use.",
        },
      });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "file_purged",
      ref: { module: "core-files", entityType: "file", entityId: id },
    });
    res.status(204).end();
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

// The records a file is attached to, each with its title and where it opens:
// the file page's "Used by". A record this viewer cannot see, or one that no
// longer resolves, is left out rather than shown as a bare id.
filesRouter.get(
  "/:id/used-by",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_files_attachments as fa")
      .innerJoin("core_files_files as f", "f.id", "fa.file_id")
      .select(["fa.id as attachment_id", "fa.source_module", "fa.source_type", "fa.source_id", "fa.role"])
      .where("fa.file_id", "=", id)
      .where("f.deleted_at", "is", null)
      .orderBy("fa.created_at", "asc")
      .execute();
    const orgId = tenantContext(req).org.id;
    const userId = sessionUser(req)?.id;
    const items = await Promise.all(
      rows.map(async (r) => {
        const kind = r.source_type.includes(":") ? r.source_type : `${r.source_module}:${r.source_type}`;
        const found = await platform().entities.lookup(orgId, kind, r.source_id, userId ? { userId } : undefined);
        if (!found) return null;
        return { attachment_id: r.attachment_id, kind, id: r.source_id, role: r.role, title: found.title, detail_url: found.detailUrl ?? null };
      }),
    );
    res.json({ items: items.filter((x) => x !== null) });
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
    // Variants are always JPEG for images; the original is what its bytes
    // say it is. A row stored under a wrong type (a PDF claimed as text or a
    // download) is healed here, on the read, so every file stored before the
    // store learned to sniff is put right the first time someone opens it.
    let rawMime = served === "original" ? row.mime_type || "application/octet-stream" : "image/jpeg";
    // A remote driver hands the bytes over whole; read them once, for the
    // type and for the response.
    const remoteBytes = resolved.localPath ? null : await readVariantBytes(ctx.org.id, id, variants, served);
    if (!resolved.localPath && !remoteBytes) {
      res.status(404).json({ error: { code: "variant_missing", message: "not found" } });
      return;
    }
    if (served === "original") {
      const head = resolved.localPath ? await headOfPath(resolved.localPath) : remoteBytes!.subarray(0, 64);
      const sniffed = sniffType(head);
      if (sniffed && sniffed !== rawMime) {
        rawMime = sniffed;
        await db
          .updateTable("core_files_files")
          .set({ mime_type: sniffed, kind: classifyKind(sniffed) })
          .where("id", "=", id)
          .execute()
          .catch(() => undefined);
      }
    }
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
      // Remote driver (S3/R2): the bytes read above.
      res.send(remoteBytes);
    }
  }),
);

// Rename and move. The bytes never change; only the name a person knows
// the file by and the folder it lives in.
// AI-REACH: crud — the core-files:file kind's update endpoint (filename, folder_id)
const FilePatch = z
  .object({ filename: z.string().trim().min(1).max(255).optional(), folder_id: z.string().uuid().nullable().optional(), metadata: z.record(z.unknown()).optional() })
  .refine((b) => b.filename !== undefined || b.folder_id !== undefined || b.metadata !== undefined, "filename, folder_id or metadata");
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
    // The file as it was: the log says what this edit changed (#4517).
    const before = await db.selectFrom("core_files_files").select(["filename", "folder_id", "metadata"]).where("id", "=", id).executeTakeFirst();
    const row = await db
      .updateTable("core_files_files")
      .set({
        ...(parsed.data.filename !== undefined ? { filename: parsed.data.filename } : {}),
        ...(to !== undefined ? { folder_id: to } : {}),
        // A custom field saved on its own merges into what the file holds.
        ...(parsed.data.metadata !== undefined ? { metadata: platform().db.mergeJsonb("metadata", parsed.data.metadata) as never } : {}),
      })
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .returning(["id", "filename", "folder_id", "mime_type", "kind", "size_bytes", "metadata", "created_at"])
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
      diff: {
        ...(parsed.data.filename !== undefined ? { name: parsed.data.filename } : {}),
        ...(to !== undefined ? { folder_id: to } : {}),
        ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
      },
      // `name` is the file's filename.
      before: before ? { ...before, name: before.filename } : undefined,
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
