// knowledge CRUD — Knowledge Base entries. Mounted at
//   /api/v1/orgs/:slug/modules/knowledge/
// Routes:
//   GET    /entries            list entries (newest first; ?pinned=1, ?kind=…, ?q=…)
//   POST   /entries            create an entry
//   GET    /entries/:id        one entry
//   PATCH  /entries/:id        edit an entry
//   DELETE /entries/:id        delete an entry

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import multer from "multer";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const entriesRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;
const ROLES = ["owner", "admin", "member"] as const;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const EntryCreate = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(200_000).optional(),
  kind: z.string().max(80).optional(),
  pinned: z.boolean().optional(),
  code: z.string().max(200).optional(),
  image_path: z.string().max(1000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
const EntryUpdate = EntryCreate.partial();

entriesRouter.get(
  "/entries",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES, "guest")) return;
    const db = tenantDb(req);
    let q = db.selectFrom("knowledge_entries").selectAll();
    if (req.query.pinned === "1" || req.query.pinned === "true") q = q.where("pinned", "=", true);
    if (typeof req.query.kind === "string" && req.query.kind) q = q.where("kind", "=", req.query.kind);
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const like = `%${req.query.q.trim()}%`;
      q = q.where((eb) => eb.or([eb("title", "ilike", like), eb("body", "ilike", like)]));
    }
    const rows = await q.orderBy("updated_at", "desc").limit(500).execute();
    res.json({ items: rows });
  }),
);

entriesRouter.post(
  "/entries",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = EntryCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .insertInto("knowledge_entries")
      .values({
        title: parsed.data.title,
        body: parsed.data.body ?? null,
        kind: parsed.data.kind ?? null,
        pinned: parsed.data.pinned ?? false,
        code: parsed.data.code ?? null,
        image_path: parsed.data.image_path ?? null,
        metadata: jsonb(parsed.data.metadata) as never,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    void platform().events.emit("knowledge.entry.created", { orgId: ctx.org.id, entryId: row.id });
    res.status(201).json(row);
  }),
);

entriesRouter.get(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES, "guest")) return;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("knowledge_entries")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    res.json(row);
  }),
);

entriesRouter.patch(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const parsed = EntryUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    for (const k of ["title", "body", "kind", "pinned", "code", "image_path"] as const) {
      if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
    }
    if (parsed.data.metadata !== undefined) patch.metadata = jsonb(parsed.data.metadata) as never;
    const row = await db
      .updateTable("knowledge_entries")
      .set(patch)
      .where("id", "=", req.params.id!)
      .returningAll()
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    void platform().events.emit("knowledge.entry.updated", { orgId: ctx.org.id, entryId: row.id });
    res.json(row);
  }),
);

entriesRouter.delete(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .deleteFrom("knowledge_entries")
      .where("id", "=", req.params.id!)
      .returning("id")
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    void platform().events.emit("knowledge.entry.deleted", { orgId: ctx.org.id, entryId: row.id });
    res.status(204).end();
  }),
);

// Upload an image for an entry (e.g. a scanner CONFIG-barcode screenshot).
// Stores via core-files and stamps the entry's image_path (a raw file URL).
// AI-REACH: takes or produces a file (multipart or binary), which an action cannot carry
entriesRouter.post(
  "/entries/:id/image",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, ...ROLES)) return;
    const file = (req as unknown as { file?: { buffer: Buffer; originalname?: string; mimetype?: string } }).file;
    if (!file) return void res.status(400).json({ error: { code: "no_file", message: "No file uploaded." } });
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const exists = await db
      .selectFrom("knowledge_entries")
      .select("id")
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!exists) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    const w = await platform().files.write(ctx.org.id, new Uint8Array(file.buffer), {
      filename: file.originalname || "entry-image",
      mimeType: file.mimetype || "application/octet-stream",
    });
    if (!w) return void res.status(500).json({ error: { code: "write_failed", message: "Could not store the image." } });
    const image_path = `/api/v1/orgs/${ctx.org.slug}/modules/core-files/files/${w.fileId}/raw`;
    await db
      .updateTable("knowledge_entries")
      .set({ image_path, updated_at: new Date() })
      .where("id", "=", req.params.id!)
      .execute();
    res.json({ image_path });
  }),
);
