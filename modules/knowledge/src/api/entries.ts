// knowledge CRUD — Knowledge Base entries. Mounted at
//   /api/v1/orgs/:slug/modules/knowledge/
// Routes:
//   GET    /entries            list entries, a page at a time (newest first;
//                              ?pinned=1, ?kind=…, ?q=…, ?limit, ?offset) + total
//   POST   /entries            create an entry
//   GET    /entries/:id        one entry
//   PATCH  /entries/:id        edit an entry
//   DELETE /entries/:id        delete an entry

import { Router } from "express";
import { sql } from "kysely";
import { likeEscape, platform, uploadOne } from "@cobblr/platform-contract";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { uploadedFile } from "@cobblr/platform-contract/upload";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { EntryCreate, EntryUpdate } from "./entry-schema.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const entriesRouter = Router({ mergeParams: true });

const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? {})}::jsonb`;
const upload = uploadOne({ maxBytes: 20 * 1024 * 1024 });

entriesRouter.get(
  "/entries",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "guest")) return;
    const db = tenantDb(req);
    let q = db.selectFrom("knowledge_entries").selectAll();
    if (req.query.pinned === "1" || req.query.pinned === "true") q = q.where("pinned", "=", true);
    if (typeof req.query.kind === "string" && req.query.kind) q = q.where("kind", "=", req.query.kind);
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const like = `%${likeEscape(req.query.q.trim())}%`;
      q = q.where((eb) => eb.or([eb("title", "ilike", like), eb("body", "ilike", like)]));
    }
    // A page and the collection's count: a knowledge base past 500 entries
    // used to answer the newest 500 and nothing else.
    const page = readListPage(req.query);
    const rows = await q
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .orderBy("updated_at", "desc")
      .orderBy("id")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    res.json(pagedAnswer(rows, page));
  }),
);

// AI-REACH: crud
entriesRouter.post(
  "/entries",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
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
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "entry_created",
      ref: { module: "knowledge", entityType: "entry", entityId: row.id },
      diff: { name: row.title, kind: row.kind },
    });
    res.status(201).json(row);
  }),
);

entriesRouter.get(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "guest")) return;
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

// AI-REACH: crud
entriesRouter.patch(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const parsed = EntryUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    for (const k of ["title", "body", "kind", "pinned", "code", "image_path"] as const) {
      if (parsed.data[k] !== undefined) patch[k] = parsed.data[k];
    }
    // The custom fields MERGE into the live row (#3625).
    if (parsed.data.metadata !== undefined) patch.metadata = platform().db.mergeJsonb("metadata", parsed.data.metadata as Record<string, unknown>) as never;
    // The row as it was: the log says what this edit changed (#4517).
    const before = await db.selectFrom("knowledge_entries").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    const row = await db
      .updateTable("knowledge_entries")
      .set(patch)
      .where("id", "=", req.params.id!)
      .returningAll()
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    void platform().events.emit("knowledge.entry.updated", { orgId: ctx.org.id, entryId: row.id });
    // The request as sent, on the record's history: the one place a value
    // a later write replaced can still be read back (#3625).
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "entry_updated",
      ref: { module: "knowledge", entityType: "entry", entityId: String(req.params.id) },
      diff: parsed.data as Record<string, unknown>,
      before,
    });
    res.json(row);
  }),
);

// AI-REACH: crud
entriesRouter.delete(
  "/entries/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .deleteFrom("knowledge_entries")
      .where("id", "=", req.params.id!)
      .returning("id")
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    void platform().events.emit("knowledge.entry.deleted", { orgId: ctx.org.id, entryId: row.id });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "entry_deleted",
      ref: { module: "knowledge", entityType: "entry", entityId: row.id },
    });
    res.status(204).end();
  }),
);

// Upload an image for an entry (e.g. a scanner CONFIG-barcode screenshot).
// Stores via core-files and stamps the entry's image_path (a raw file URL).
// AI-REACH: exempt — a multipart upload of an image's bytes; the assistant
// holds no image to send
entriesRouter.post(
  "/entries/:id/image",
  upload,
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "member")) return;
    const file = uploadedFile(req);
    if (!file) return void res.status(400).json({ error: { code: "no_file", message: "No file uploaded." } });
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const exists = await db
      .selectFrom("knowledge_entries")
      .select("id")
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!exists) return void res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
    const w = await platform().files.write(ctx.org.id, { path: file.path, size: file.size, sha256: file.sha256 }, {
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
