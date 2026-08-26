// Entity-kind resolver for core-files:file. Lets other modules
// look up a file via platform.entities.lookup() — typically to
// render a thumbnail or pull the medium-variant URL into a card.
//
// Also registers the platform files-byte reader: the server-side
// seam (platform().files.read) other modules use to pull a stored
// file's raw bytes — print farm uploading gcode, vision reading a
// scan photo — without importing core-files or its disk layout.

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { CoreFilesDB, FileVariants } from "../db.js";
import { readVariantBytes, storeUpload } from "./storage.js";

let registered = false;

export function registerFileResolvers(): void {
  if (registered) return;
  registered = true;

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
  platform().files.registerWriter(async (orgId, bytes, opts) => {
    const fileId = randomUUID();
    const stored = await storeUpload(orgId, fileId, Buffer.from(bytes), opts.mimeType || "application/octet-stream");
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreFilesDB>;
    await db
      .insertInto("core_files_files")
      .values({
        id: fileId,
        org_id: orgId,
        owner_user_id: null,
        filename: opts.filename || "untitled",
        mime_type: stored.mime_type,
        size_bytes: String(stored.size_bytes),
        sha256: stored.sha256,
        variants: stored.variants,
        kind: stored.kind,
        width: stored.width,
        height: stored.height,
      })
      .execute();
    platform().metering.record({ orgId, kind: "files.bytes_stored", quantity: stored.size_bytes, meta: { fileId, kind: stored.kind } });
    return { fileId, mimeType: stored.mime_type, sizeBytes: stored.size_bytes, kind: stored.kind };
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
      .returningAll()
      .executeTakeFirstOrThrow();
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
    title: row.filename,
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
