// /api/v1/orgs/:slug/modules/digifab/library —
// the file library: stored 3MF/gcode files you send to machines, each previewed
// by its slicer-embedded plate thumbnail. Upload stores the bytes in core-files
// and extracts the thumbnail; "send" creates a normal job that uploads those
// bytes to the chosen printer/pool (the existing send+poll path).

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { extractThumbnail, isLibraryFile } from "../library/extract-thumbnail.js";
import { enqueuePoll } from "../poll-worker.js";

export const libraryRouter = Router({ mergeParams: true });

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB — a large multi-plate 3MF fits.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const ROW = ["id", "name", "file_id", "thumbnail_file_id", "kind", "size_bytes", "plate_count", "notes", "created_at", "updated_at"] as const;

// GET / — list library items, newest first.
libraryRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req).selectFrom("digifab_library").select(ROW).orderBy("created_at", "desc").execute();
    res.json({ items: rows });
  }),
);

// POST / — upload a 3MF/gcode (multipart `file`). Stores bytes + extracts thumb.
libraryRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string; mimetype: string; size: number } }).file;
    if (!file?.buffer) return void res.status(400).json({ error: { code: "missing_file", message: "Multipart field 'file' is required." } });
    if (!isLibraryFile(file.originalname)) {
      return void res.status(400).json({ error: { code: "bad_type", message: "Upload a .3mf or .gcode file." } });
    }
    const stored = await platform().files.write(orgId, file.buffer, { filename: file.originalname, mimeType: file.mimetype || "application/octet-stream" });
    if (!stored) return void res.status(500).json({ error: { code: "store_failed", message: "File storage is unavailable." } });

    // Pull the slicer thumbnail; store it as its own small image (best-effort).
    let thumbId: string | null = null;
    let plateCount = 1;
    try {
      const ex = extractThumbnail(file.originalname, file.buffer);
      plateCount = ex.plateCount;
      if (ex.png) {
        const t = await platform().files.write(orgId, ex.png, { filename: "thumb.png", mimeType: "image/png" });
        thumbId = t?.fileId ?? null;
      }
    } catch (e) {
      console.warn(`[digifab] thumbnail extract failed for ${file.originalname}:`, (e as Error).message);
    }

    const name = (typeof req.body?.name === "string" && req.body.name.trim()) || file.originalname;
    const kind = /\.3mf$/i.test(file.originalname) ? "3mf" : "gcode";
    const row = await tenantDb(req)
      .insertInto("digifab_library")
      .values({ name: String(name).slice(0, 300), file_id: stored.fileId, thumbnail_file_id: thumbId, kind, size_bytes: Math.min(file.size, 2_000_000_000), plate_count: plateCount, notes: null })
      .returning(ROW)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

const Rename = z.object({ name: z.string().min(1).max(300).optional(), notes: z.string().max(2000).nullable().optional() });
libraryRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Rename.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name != null) patch.name = parsed.data.name;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    const row = await tenantDb(req).updateTable("digifab_library").set(patch).where("id", "=", req.params.id!).returning(ROW).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such library item" } });
    res.json(row);
  }),
);

libraryRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const row = await tenantDb(req).deleteFrom("digifab_library").where("id", "=", req.params.id!).returning(["id"]).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such library item" } });
    res.json({ ok: true });
  }),
);

// POST /:id/send — queue a print of this library file to a printer or pool. Reuses
// the job pipeline (file_id → upload bytes at send). Mirrors POST /jobs.
const Send = z.object({
  connection_id: z.string().uuid().optional(),
  target_device: z.string().max(200).nullable().optional(),
  target_pool: z.string().uuid().nullable().optional(),
});
libraryRouter.post(
  "/:id/send",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Send.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const item = await db.selectFrom("digifab_library").select(["name", "file_id"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!item) return void res.status(404).json({ error: { code: "not_found", message: "no such library item" } });
    const pool = parsed.data.target_pool ?? null;
    if (!parsed.data.connection_id && !pool) {
      return void res.status(400).json({ error: { code: "no_target", message: "a send needs a connection_id or a target_pool" } });
    }
    const job = await db
      .insertInto("digifab_jobs")
      .values({
        connection_id: pool ? null : (parsed.data.connection_id ?? null),
        file_ref: item.name,
        target_device: parsed.data.target_device ?? null,
        target_pool: pool,
        file_id: item.file_id,
      })
      .returning(["id", "status", "target_pool"])
      .executeTakeFirstOrThrow();
    if (pool) {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(orgId);
      return void res.status(201).json({ job_id: job.id, status: "queued" });
    }
    // Direct send to a connection/device — fire it now, then hand to the poller.
    const { sendJob } = await import("../jobs-core.js");
    const r = await sendJob(db, orgId, job.id);
    if (!r.ok) return void res.status(502).json({ error: { code: r.code, message: "send failed" }, job_id: job.id });
    if (r.shouldPoll) await enqueuePoll(orgId, job.id);
    res.status(201).json({ job_id: job.id, status: r.status });
  }),
);
