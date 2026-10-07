// /api/v1/orgs/:slug/modules/digifab/library —
// the file library: stored 3MF/gcode files you send to machines, each previewed
// by its slicer-embedded plate thumbnail. Upload stores the bytes in core-files
// and extracts the thumbnail; "send" creates a normal job that uploads those
// bytes to the chosen printer/pool (the existing send+poll path).

import { isLayoutFile } from "../laser-plans.js";
import { Router } from "express";
import { z } from "zod";
import { platform, uploadOne } from "@cobblr/platform-contract";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { extractThumbnail, isLibraryFile } from "../library/extract-thumbnail.js";
import { extractPlateMetadata } from "../library/extract-metadata.js";
import { plateView } from "../library/plate-view.js";
import { LaserMaterialSchema } from "../laser-material.js";

export const libraryRouter = Router({ mergeParams: true });

// A 3MF or gcode is a design file: up to this deployment's design-file limit
// (200 MB self-hosted), streamed to disk by the upload door.
const upload = uploadOne({});

const ROW = ["id", "name", "file_id", "thumbnail_file_id", "kind", "size_bytes", "plate_count", "notes", "metadata", "created_at", "updated_at"] as const;

// GET / — list library items, newest first.
libraryRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req).selectFrom("digifab_library").select(ROW).orderBy("created_at", "desc").execute();
    res.json({ items: rows });
  }),
);

// POST / — upload a 3MF/gcode (multipart `file`). Stores bytes + extracts thumb.
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
libraryRouter.post(
  "/",
  upload,
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const file = uploadedFile(req);
    if (!file) return void res.status(400).json({ error: { code: "missing_file", message: "Multipart field 'file' is required." } });
    if (!isLibraryFile(file.originalname)) {
      return void res.status(400).json({ error: { code: "bad_type", message: "Upload a .3mf, .gcode, .goo, SVG, DXF, AI, PDF, PNG, JPEG or .lbrn2 file." } });
    }
    const stored = await platform().files.write(orgId, { path: file.path, size: file.size, sha256: file.sha256 }, { filename: file.originalname, mimeType: file.mimetype || "application/octet-stream" });
    if (!stored) return void res.status(500).json({ error: { code: "store_failed", message: "File storage is unavailable." } });

    // What the extractors read, taken from the file on disk (never read whole).
    const view = await plateView(file.path, file.originalname).catch(() => Buffer.alloc(0));
    // Pull the slicer thumbnail; store it as its own small image (best-effort).
    let thumbId: string | null = null;
    let plateCount = 1;
    try {
      const ex = extractThumbnail(file.originalname, view);
      plateCount = ex.plateCount;
      if (ex.png) {
        const t = await platform().files.write(orgId, ex.png, { filename: "thumb.png", mimeType: "image/png" });
        thumbId = t?.fileId ?? null;
      }
    } catch (e) {
      console.warn(`[digifab] thumbnail extract failed for ${file.originalname}:`, (e as Error).message);
    }

    const name = (typeof req.body?.name === "string" && req.body.name.trim()) || file.originalname;
    const extension = file.originalname.split(".").pop()!.toLowerCase();
    const kind = ["gco", "g"].includes(extension) ? "gcode" : extension;
    // Slicer metadata (est time / material / layer / grams / parts-per-plate):
    // comment headers first, the `Nx …_PLA_…_5h11m` filename convention as
    // fallback. Best-effort — a parse failure must never block an upload.
    let metadata: Record<string, unknown> = {};
    try {
      metadata = extractPlateMetadata(file.originalname, view) as Record<string, unknown>;
    } catch (e) {
      console.warn(`[digifab] metadata extract failed for ${file.originalname}:`, (e as Error).message);
    }
    const row = await tenantDb(req)
      .insertInto("digifab_library")
      .values({ name: String(name).slice(0, 300), file_id: stored.fileId, thumbnail_file_id: thumbId, kind, size_bytes: Math.min(file.size, 2_000_000_000), plate_count: plateCount, notes: null, metadata })
      .returning(ROW)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

const Rename = z.object({ name: z.string().min(1).max(300).optional(), notes: z.string().max(2000).nullable().optional(), laser_material: LaserMaterialSchema.optional() });
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
libraryRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Rename.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name != null) patch.name = parsed.data.name;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.laser_material) {
      const before = await tenantDb(req).selectFrom("digifab_library").select("metadata").where("id", "=", req.params.id!).executeTakeFirst();
      if ((before?.metadata.laser_layout || before?.metadata.cutter_plan)) return void res.status(409).json({ error: { code: "generated_material", message: "This layout keeps the material chosen in its plan. Make a new plan to change it." } });
      patch.metadata = platform().db.mergeJsonb("metadata", { laser_material: parsed.data.laser_material });
    }
    const row = await tenantDb(req).updateTable("digifab_library").set(patch).where("id", "=", req.params.id!).returning(ROW).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such library item" } });
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
libraryRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const before = await tenantDb(req).selectFrom("digifab_library").select("metadata").where("id", "=", req.params.id!).executeTakeFirst();
    if ((before?.metadata.laser_layout || before?.metadata.cutter_plan)) return void res.status(409).json({ error: { code: "generated_layout", message: "Keep this run's generated project. Cancel the run to discard its queued jobs." } });
    const plan = await tenantDb(req).selectFrom("digifab_laser_plans").select("id").where("library_id", "=", req.params.id!).executeTakeFirst();
    if (plan) return void res.status(409).json({ error: { code: "laser_plan_exists", message: "This drawing belongs to a saved laser layout. Discard unqueued layouts before deleting it. Keep a queued run's source drawing." } });
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
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
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
    if (await isLayoutFile(tenantDb(req), item.file_id)) return void res.status(409).json({ error: { code: "layout_copy", message: "Use this layout's queued sheet job. Make a new plan to cut another batch." } });
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
    await platform().activity.log({
      orgId,
      userId: sessionUser(req)?.id ?? null,
      action: "job_created",
      ref: { module: "digifab", entityType: "job", entityId: job.id },
      diff: { name: item.name },
    });
    if (pool) {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(orgId);
      return void res.status(201).json({ job_id: job.id, status: "queued" });
    }
    // Direct send to a connection/device — fire it now, then hand to the poller.
    const { sendAndWatch } = await import("./jobs.js");
    const r = await sendAndWatch(db, orgId, job.id);
    if (!r.ok) return void res.status(502).json({ error: { code: r.code, message: "send failed" }, job_id: job.id });
    res.status(201).json({ job_id: job.id, status: r.status });
  }),
);
