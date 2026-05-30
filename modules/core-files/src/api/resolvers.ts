// Entity-kind resolver for core-files:file. Lets other modules
// look up a file via platform.entities.lookup() — typically to
// render a thumbnail or pull the medium-variant URL into a card.
//
// Also registers the platform files-byte reader: the server-side
// seam (platform().files.read) other modules use to pull a stored
// file's raw bytes — print farm uploading gcode, vision reading a
// scan photo — without importing core-files or its disk layout.

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { CoreFilesDB, FileVariants } from "../db.js";
import { readVariantBytes } from "./storage.js";

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
