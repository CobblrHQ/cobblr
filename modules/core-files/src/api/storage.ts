// Filesystem ops + sharp variant generation. Everything below the
// HTTP layer; routes shouldn't touch fs / sharp directly.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import sharp from "sharp";
import type { FileKind, FileVariants } from "../db.js";

// Default storage root: <repo>/_files. Overridable per-deploy.
// _files (leading underscore) sorts to the top and is conventionally
// gitignored elsewhere in the workspace.
const DEFAULT_FILES_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  // From dist/api/storage.js or src/api/storage.ts, walk up to repo root.
  // ../../../.. lands at the workspace root for both layouts.
  return resolve(here, "..", "..", "..", "..", "_files");
})();

export function filesRoot(): string {
  return process.env.COBBLR_FILES_ROOT
    ? resolve(process.env.COBBLR_FILES_ROOT)
    : DEFAULT_FILES_ROOT;
}

/** Absolute path to a file's per-tenant directory. */
export function fileDir(orgId: string, fileId: string): string {
  return join(filesRoot(), orgId, fileId);
}

/** Resolve a variant's `path` (relative, as stored in `variants`) to
 *  the absolute on-disk path. Throws if the path tries to escape. */
export function resolveVariantPath(
  orgId: string,
  fileId: string,
  relPath: string,
): string {
  const dir = fileDir(orgId, fileId);
  const abs = resolve(dir, relPath);
  if (!abs.startsWith(dir + "/") && abs !== dir) {
    throw new Error("path traversal blocked");
  }
  return abs;
}

interface StoredFile {
  variants: FileVariants;
  sha256: string;
  size_bytes: number;
  kind: FileKind;
  width: number | null;
  height: number | null;
  mime_type: string;
}

/** Persist an uploaded buffer to disk + generate image variants if
 *  applicable. Returns the metadata that becomes columns on the
 *  `files` row. */
export async function storeUpload(
  orgId: string,
  fileId: string,
  buffer: Buffer,
  declaredMime: string,
): Promise<StoredFile> {
  const dir = fileDir(orgId, fileId);
  await mkdir(dir, { recursive: true });

  const sha = createHash("sha256").update(buffer).digest("hex");
  const ext = extFromMime(declaredMime);
  const originalRel = `original${ext}`;
  await writeFile(join(dir, originalRel), buffer);

  const baseKind = classifyKind(declaredMime);
  const variants: FileVariants = {
    original: { path: originalRel, bytes: buffer.length },
  };

  let width: number | null = null;
  let height: number | null = null;
  let actualMime = declaredMime;

  if (baseKind === "image") {
    try {
      const meta = await sharp(buffer, { failOn: "none" }).metadata();
      if (meta.width && meta.height) {
        width = meta.width;
        height = meta.height;
      }
      // Sharp's reported format is more trustworthy than the declared
      // mime — e.g. browsers tag .heic as application/octet-stream.
      const sharpFmt = meta.format ? `image/${meta.format}` : declaredMime;
      actualMime = sharpFmt;

      // Variants: medium (longest side 1024) + thumb (256). Always
      // encode to JPEG — smaller than PNG, lossy is fine for derived
      // views, and one codec keeps the serving path simple. The
      // ORIGINAL is preserved untouched so callers needing the
      // source bytes (re-export, archival) still have them.
      const medium = await sharp(buffer, { failOn: "none" })
        .rotate() // honour EXIF orientation before resize
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      await writeFile(join(dir, "medium.jpg"), medium.data);
      variants.medium = {
        path: "medium.jpg",
        bytes: medium.data.length,
        width: medium.info.width,
        height: medium.info.height,
      };

      const thumb = await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      await writeFile(join(dir, "thumb.jpg"), thumb.data);
      variants.thumb = {
        path: "thumb.jpg",
        bytes: thumb.data.length,
        width: thumb.info.width,
        height: thumb.info.height,
      };
    } catch (err) {
      // Sharp couldn't read it as an image. Treat as 'other' but
      // keep the upload — caller still gets metadata + original.
      console.warn(`[core-files] sharp failed for ${fileId}; storing as 'other':`, (err as Error).message);
      return {
        variants,
        sha256: sha,
        size_bytes: buffer.length,
        kind: "other",
        width: null,
        height: null,
        mime_type: declaredMime,
      };
    }
  }

  return {
    variants,
    sha256: sha,
    size_bytes: buffer.length,
    kind: baseKind,
    width,
    height,
    mime_type: actualMime,
  };
}

/** Best-effort: remove the file's on-disk directory. Soft-deleted
 *  rows can call this on the way to permanent purge. */
export async function removeStoredFile(orgId: string, fileId: string): Promise<void> {
  await rm(fileDir(orgId, fileId), { recursive: true, force: true });
}

/** Stream a variant's bytes back to the caller. Returns the path so
 *  the route can pick between sendFile (Express built-in) and a manual
 *  stream depending on what's most convenient. */
export async function readVariant(
  orgId: string,
  fileId: string,
  variants: FileVariants,
  which: "original" | "medium" | "thumb",
): Promise<{ path: string; bytes: number } | null> {
  const v = variants[which];
  if (!v) return null;
  const abs = resolveVariantPath(orgId, fileId, v.path);
  const exists = await stat(abs).then(
    () => true,
    () => false,
  );
  if (!exists) return null;
  return { path: abs, bytes: v.bytes };
}

/** Convenience: byte-buffer read for inline rendering / tests. */
export async function readVariantBytes(
  orgId: string,
  fileId: string,
  variants: FileVariants,
  which: "original" | "medium" | "thumb",
): Promise<Buffer | null> {
  const r = await readVariant(orgId, fileId, variants, which);
  if (!r) return null;
  return readFile(r.path);
}

function classifyKind(mime: string): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/zip" ||
    mime.includes("msword") ||
    mime.includes("officedocument")
  ) {
    return "document";
  }
  return "other";
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/markdown": ".md",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return map[mime.toLowerCase()] ?? ".bin";
}
