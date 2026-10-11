import { groupListRows } from "@cobblr/platform-contract/grouped-list";
import { registerDeletedAttachments } from "../deletion-participant.js";
import { purgeFile, restoreFile } from "../purge.js";
// Entity-kind resolver for core-files:file. Lets other modules
// look up a file via platform.entities.lookup() — typically to
// render a thumbnail or pull the medium-variant URL into a card.
//
// Also registers the platform files-byte reader: the server-side
// seam (platform().files.read) other modules use to pull a stored
// file's raw bytes — print farm uploading gcode, vision reading a
// scan photo — without importing core-files or its disk layout.

import { RecordRestoreRefused } from "@cobblr/platform-contract";
import { readableFilename } from "./filename.js";
import { sameBytes } from "./intake.js";
import { notePhotoSource, photoSourceOf } from "./photo-source.js";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { registerRowHistoryWriter, likeEscape, platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { CoreFilesDB, FileVariants } from "../db.js";
import { registerDocumentImageReader } from "@cobblr/platform-contract/document-images";
import { extractPdfImages } from "./pdf-images.js";
import { eraseWorkspaceFiles, fingerprintOf, listLocalWorkspaceFolders, readVariantBytes, removeStoredFile, storeUpload } from "./storage.js";

let registered = false;

export function registerFileResolvers(): void {
  if (registered) return;
  registered = true;
  registerDeletedAttachments();
  platform().deletedRecords.registerLifecycle("core-files:file", {
    restore: async (orgId, id) => {
      const result = await restoreFile(await platform().tenants.getDb(orgId) as Kysely<CoreFilesDB>, orgId, id);
      if (!result.ok) throw new RecordRestoreRefused(result.message, result.code === "quota_exceeded" ? 413 : 404);
    },
    purge: async (orgId, id) => {
      const db = await platform().tenants.getDb(orgId) as Kysely<CoreFilesDB>;
      if (!await db.selectFrom("core_files_files").select("id").where("id", "=", id).executeTakeFirst()) return true;
      return purgeFile(db, orgId, id);
    },
  });
  registerRowHistoryWriter("core-files:file", "core_files_files");

  platform().entities.registerResolver(
    "core-files:file",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
      const row = await db
        .selectFrom("core_files_files")
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!row) return null;
      return toResolvedFile(orgId, row);
    },
  );

  // Search reaches a file by its name ("the beanie pattern"): core-search
  // asks every kind's list resolver, and without one a file could only be
  // found by scrolling (#3753). Newest first; `q` matches the name.
  platform().entities.registerListResolver("core-files:file", async (orgId, query) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    // A copy that repeats another file's bytes is that file: listed once.
    let q = db.selectFrom("core_files_files").selectAll().where("deleted_at", "is", null).where("same_as", "is", null);
    const text = (query.q ?? "").trim();
    if (text) q = q.where("filename", "ilike", `%${likeEscape(text)}%`);
    const rows = (await groupListRows(db, q .orderBy("created_at", "desc"), query)) ?? await q
      .orderBy("created_at", "desc")
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0)
      .execute();
    return { items: rows.map((r) => toResolvedFile(orgId, r)) };
  });

  // The pictures inside a PDF, for every module that reads one (a pattern's
  // photo, a scanned receipt). A file that will not parse has no pictures.
  registerDocumentImageReader((bytes, opts) => extractPdfImages(bytes, opts).catch(() => []));

  // The byte-reading seam. core-files owns the disk layout, so it's
  // the natural place to satisfy platform().files.read().
  platform().files.registerReader(async (orgId, fileId, variant) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const row = await db
      .selectFrom("core_files_files")
      .select(["filename", "mime_type", "variants"])
      .where("id", "=", fileId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) return null;
    const buf = await readVariantBytes(orgId, fileId, row.variants as FileVariants, variant);
    if (!buf) return null;
    return {
      bytes: new Uint8Array(buf),
      filename: row.filename,
      // Derived variants are always JPEG; the original keeps its mime.
      mimeType: variant === "original" ? row.mime_type : "image/jpeg",
    };
  });

  // The byte-WRITING seam — mirrors POST /files but server-side (no request /
  // session): generate an id, store bytes + variants, insert the DB row, meter.
  // Used by the graduation import to COPY a photo into the new workspace.
  // A workspace being deleted: every file it ever stored, soft-deleted ones
  // included, before its database (which holds the list) is dropped.
  platform().files.registerWorkspaceEraser(async (orgId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const rows = await db.selectFrom("core_files_files").select("id").execute();
    await eraseWorkspaceFiles(
      orgId,
      rows.map((r) => r.id),
    );
  });

  platform().files.registerWorkspaceFolderLister(listLocalWorkspaceFolders);

  platform().files.registerWriter(async (orgId, source, opts) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const fp = await fingerprintOf(source);
    const sha = fp.sha256;
    // The same bytes already in this workspace are that file, not a second
    // copy: a picture fetched twice (a catalog download that ran twice) was
    // stored twice and listed twice (#3859). The upload route asks the same
    // question (sameBytes). Two writes of one picture at once (a backfill
    // downloads rows in parallel) would both find nothing and both store, so
    // the question and the insert hold one lock per content hash.
    return db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${"core-files:" + sha}))`.execute(tx);
      const same = await sameBytes(tx, fp);
      if (same) {
        if (opts.photoSource) await notePhotoSource(tx, same.id, opts.photoSource);
        return { fileId: same.id, mimeType: same.mime_type, sizeBytes: Number(same.size_bytes), kind: same.kind, existed: true };
      }
      const fileId = randomUUID();
      const stored = await storeUpload(orgId, fileId, source, opts.mimeType || "application/octet-stream", fp);
      try {
        await tx
          .insertInto("core_files_files")
          .values({
            id: fileId,
            org_id: orgId,
            owner_user_id: null,
            filename: readableFilename(opts.filename),
            mime_type: stored.mime_type,
            size_bytes: String(stored.size_bytes),
            sha256: stored.sha256,
            variants: stored.variants,
            kind: stored.kind,
            width: stored.width,
            height: stored.height,
            ...(opts.photoSource ? { metadata: { photo_source: opts.photoSource } } : {}),
          })
          .execute();
      } catch (err) {
        await removeStoredFile(orgId, fileId).catch(() => {});
        throw err;
      }
      platform().metering.record({ orgId, kind: "files.bytes_stored", quantity: stored.size_bytes, meta: { fileId, kind: stored.kind } });
      return { fileId, mimeType: stored.mime_type, sizeBytes: stored.size_bytes, kind: stored.kind };
    });
  });

  // The ATTACH seam - POST /attachments without a request. A module reacting
  // to an upload from an event handler has no bearer to self-call with, and
  // the row is core-files' to write. Emits the same event the route does, so a
  // wire on core-files.attachment.created cannot tell the two doors apart.
  platform().files.registerAttacher(async (orgId, spec) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const file = await db
      .selectFrom("core_files_files")
      .select("id")
      .where("id", "=", spec.fileId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!file) throw new Error(`core-files: no such file ${spec.fileId}`);
    const role = spec.role ?? null;
    const existing = await db
      .selectFrom("core_files_attachments")
      .select("id")
      .where("file_id", "=", spec.fileId)
      .where("source_module", "=", spec.source_module)
      .where("source_type", "=", spec.source_type)
      .where("source_id", "=", spec.source_id)
      .where((eb) => (role === null ? eb("role", "is", null) : eb("role", "=", role)))
      .executeTakeFirst();
    if (existing) return { attachmentId: existing.id, existed: true };
    const row = await db
      .insertInto("core_files_attachments")
      .values({
        file_id: spec.fileId,
        source_module: spec.source_module,
        source_type: spec.source_type,
        source_id: spec.source_id,
        role,
        sort_order: spec.sort_order ?? 0,
      })
      // Attached twice at once (a double drop): the first one stands.
      .onConflict((oc) => oc.columns(["file_id", "source_module", "source_type", "source_id", "role"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const first = await db
        .selectFrom("core_files_attachments")
        .select("id")
        .where("file_id", "=", spec.fileId)
        .where("source_module", "=", spec.source_module)
        .where("source_type", "=", spec.source_type)
        .where("source_id", "=", spec.source_id)
        .where((eb) => (role === null ? eb("role", "is", null) : eb("role", "=", role)))
        .executeTakeFirstOrThrow();
      return { attachmentId: first.id, existed: true };
    }
    await platform().events.emit("core-files.attachment.created", {
      orgId,
      attachmentId: row.id,
      fileId: row.file_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
      role: row.role,
    });
    return { attachmentId: row.id, existed: false };
  });

  // The DETACH seam - DELETE /attachments/:id without a request. The file
  // stays; only the "is the <role> of" row goes, and the same event fires.
  platform().files.registerDetacher(async (orgId, attachmentId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const row = await db
      .deleteFrom("core_files_attachments")
      .where("id", "=", attachmentId)
      .returning(["id", "file_id", "source_module", "source_type", "source_id", "role"])
      .executeTakeFirst();
    if (!row) return false;
    await platform().events.emit("core-files.attachment.deleted", {
      orgId,
      attachmentId: row.id,
      fileId: row.file_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
      role: row.role,
    });
    return true;
  });

  // The REMOVE seam: a file gone for good now, not kept in Recently deleted,
  // for the plain copy of a document just put in the Vault (#5242). Deleted
  // as DELETE /files/:id deletes, then purged as the sweep purges; a live copy
  // that still names it keeps it, and the caller hears false.
  platform().files.registerRemover(async (orgId, fileId) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const deleted = await db.updateTable("core_files_files").set({ deleted_at: new Date() }).where("id", "=", fileId).where("deleted_at", "is", null).returning("id").executeTakeFirst();
    if (deleted) await platform().events.emit("core-files.file.deleted", { orgId, fileId });
    return purgeFile(db, orgId, fileId);
  });

  // The DESCRIBE seam: what a file is, for a person reading about it (a
  // record's history names a photo by this, never by its storage path).
  platform().files.registerDescriber(async (orgId, fileIds) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const rows = await db
      .selectFrom("core_files_files")
      .select(["id", "filename", "mime_type", "kind", "size_bytes", "width", "height", "metadata"])
      .where("id", "in", fileIds)
      .where("deleted_at", "is", null)
      .execute();
    return rows.map((r) => ({
      fileId: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      kind: r.kind,
      sizeBytes: Number(r.size_bytes),
      width: r.width,
      height: r.height,
      photoSource: photoSourceOf(r.metadata),
    }));
  });

  // The LIST seam - GET /attachments for one entity, same order, no request.
  platform().files.registerAttachmentLister(async (orgId, source) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    const rows = await db
      .selectFrom("core_files_attachments as fa")
      .innerJoin("core_files_files as f", "f.id", "fa.file_id")
      .select([
        "fa.id as id",
        "fa.file_id as file_id",
        "fa.role as role",
        "fa.sort_order as sort_order",
        "fa.created_at as created_at",
        "f.filename as filename",
        "f.mime_type as mime_type",
        "f.kind as kind",
        "f.width as width",
        "f.height as height",
        "f.metadata as metadata",
      ])
      .where("fa.source_module", "=", source.source_module)
      .where("fa.source_type", "=", source.source_type)
      .where("fa.source_id", "=", source.source_id)
      .where("f.deleted_at", "is", null)
      .orderBy("fa.sort_order", "asc")
      .orderBy("fa.created_at", "asc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      fileId: r.file_id,
      role: r.role,
      sort_order: r.sort_order,
      filename: r.filename,
      mimeType: r.mime_type,
      kind: r.kind,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
      photoSource: photoSourceOf(r.metadata),
    }));
  });
}

function toResolvedFile(
  orgId: string,
  row: {
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: string;
    kind: string;
    width: number | null;
    height: number | null;
    variants: FileVariants;
  },
): ResolvedEntity {
  // Image-path points at the canonical-display URL on the api: the
  // medium variant for images, the raw bytes for anything else. The
  // platform/web layer can then serve through this URL after auth.
  // Note this is the API-relative path; embedding callers prefix
  // with the orgs/:slug/modules/core-files/ scope.
  const hasMedium = row.kind === "image" && !!row.variants.medium;
  const imagePath = hasMedium
    ? `/files/${row.id}/raw?variant=medium`
    : `/files/${row.id}/raw`;
  return {
    kind: "core-files:file",
    id: row.id,
    // A name stored before readableFilename (a query string like "?i=…jpg")
    // still reads as the file everywhere the record is shown (#3833).
    title: readableFilename(row.filename, row.filename),
    subtitle: row.mime_type,
    image_path: row.kind === "image" ? imagePath : undefined,
    detailUrl: `/files/${row.id}`,
    fields: {
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      kind: row.kind,
      width: row.width,
      height: row.height,
      image_path: imagePath,
    },
  };
  // orgId is unused for ResolvedEntity construction but kept in the
  // signature for parity with sibling modules — same arg shape.
  void orgId;
}
