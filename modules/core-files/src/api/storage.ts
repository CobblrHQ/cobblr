// Filesystem ops + sharp variant generation. Everything below the
// HTTP layer; routes shouldn't touch fs / sharp directly.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import sharp from "sharp";
import { platform, type FilesDriver, type WorkspaceFolder } from "@cobblr/platform-contract";
import type { FileKind, FileVariants } from "../db.js";
import { PERSONAL_READER_PLACE, PersonalDocumentRefused, readPersonalDocument } from "@cobblr/platform-contract/personal-documents";
import { sniffType } from "@cobblr/platform-contract/sniff-type";

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

// ── Storage driver seam ──────────────────────────────────────────────────
// Blob persistence is behind a driver so a hosted deployment can swap local
// disk for object storage (S3/R2) without touching the image-processing or
// route layers. Open core ships + falls back to this local-fs driver; the
// cloud overlay calls platform().files.registerDriver(...) at boot to override.
const localDriver: FilesDriver = {
  async put(orgId, fileId, relPath, bytes) {
    await mkdir(fileDir(orgId, fileId), { recursive: true });
    await writeFile(resolveVariantPath(orgId, fileId, relPath), bytes);
  },
  // An upload already on this disk becomes the stored file by a hard link (no
  // copy, no read); across disks it is copied, still without holding it.
  async putFile(orgId, fileId, relPath, srcPath) {
    await mkdir(fileDir(orgId, fileId), { recursive: true });
    const dest = resolveVariantPath(orgId, fileId, relPath);
    try {
      await link(srcPath, dest);
    } catch {
      await copyFile(srcPath, dest);
    }
  },
  async getBytes(orgId, fileId, relPath) {
    try {
      return await readFile(resolveVariantPath(orgId, fileId, relPath));
    } catch {
      return null;
    }
  },
  async remove(orgId, fileId) {
    await rm(fileDir(orgId, fileId), { recursive: true, force: true });
  },
  localPath(orgId, fileId, relPath) {
    try {
      return resolveVariantPath(orgId, fileId, relPath);
    } catch {
      return null;
    }
  },
  async removeWorkspace(orgId) {
    await rm(workspaceDir(orgId), { recursive: true, force: true });
  },
};

/** A workspace's folder under the files root. Refuses anything that is not a
 *  plain id, so a bad value can never name the root itself or a sibling. */
function workspaceDir(orgId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error(`not a workspace id: ${orgId}`);
  return join(filesRoot(), orgId);
}

/** Every uuid-named folder under the files root, with its size and newest
 *  write. Only the local driver keeps folders; any other answers null (it
 *  cannot be listed this way). Read-only. */
export async function listLocalWorkspaceFolders(): Promise<WorkspaceFolder[] | null> {
  if (driver() !== localDriver) return null;
  let names: string[];
  try {
    names = await readdir(filesRoot());
  } catch {
    return [];
  }
  const out: WorkspaceFolder[] = [];
  for (const name of names) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    const t = { bytes: 0, newestAt: 0 };
    await measure(join(filesRoot(), name), t);
    out.push({ orgId: name, ...t });
  }
  return out;
}

async function measure(path: string, t: { bytes: number; newestAt: number }): Promise<void> {
  const s = await stat(path);
  t.newestAt = Math.max(t.newestAt, s.mtimeMs);
  if (!s.isDirectory()) {
    t.bytes += s.size;
    return;
  }
  for (const e of await readdir(path)) await measure(join(path, e), t);
}

/** Remove every stored byte of a workspace: each file through the active
 *  driver (object storage included), then whatever is left under its folder. */
export async function eraseWorkspaceFiles(orgId: string, fileIds: string[]): Promise<void> {
  const d = driver();
  for (const id of fileIds) await d.remove(orgId, id);
  if (d.removeWorkspace) await d.removeWorkspace(orgId);
  else if (d !== localDriver) await localDriver.removeWorkspace!(orgId);
}

/** The active blob driver: the overlay's override, else local disk. */
function driver(): FilesDriver {
  return platform().files.getDriver() ?? localDriver;
}

/** What a file is stored from: bytes in hand, or a file already on disk (an
 *  upload the door streamed there, with the hash it took as it arrived). */
export type FileSourceIn = Uint8Array | { path: string; size: number; sha256?: string };

/** The two facts that say two files are the same bytes. */
export interface Fingerprint {
  sha256: string;
  size: number;
}

/** A source's fingerprint, reading a file on disk as a stream when its hash
 *  was not taken on the way in. */
export async function fingerprintOf(src: FileSourceIn): Promise<Fingerprint> {
  if (src instanceof Uint8Array) return { sha256: createHash("sha256").update(src).digest("hex"), size: src.length };
  if (src.sha256) return { sha256: src.sha256, size: src.size };
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(src.path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

export interface StoredFile {
  variants: FileVariants;
  sha256: string;
  size_bytes: number;
  kind: FileKind;
  width: number | null;
  height: number | null;
  mime_type: string;
}

/** Bytes a workspace has just had read as ordinary, so the same file
 *  stored again (a re-upload, a zip entry checked and then stored, a
 *  pattern attached twice) is not read again: a typed PDF's pictures cost
 *  seconds of OCR. Only an ordinary verdict is kept; a refusal is read
 *  again. Scoped to the workspace, or an upload's speed would tell one
 *  workspace what another had just stored. */
const ordinaryRecently = new Map<string, number>();
const ORDINARY_TTL_MS = 15 * 60_000;

export async function assertSharedFileSource(source: FileSourceIn, claimedMime: string, orgId?: string, known?: Fingerprint): Promise<void> {
  const head = await headOf(source, 4096);
  const mime = sniffType(head) || claimedMime;
  if (!/^(?:image\/|application\/pdf|text\/)/.test(mime)) return;
  const key = orgId ? `${orgId}:${mime}:${(known ?? (await fingerprintOf(source))).sha256}` : null;
  const kept = key ? ordinaryRecently.get(key) : undefined;
  if (key && kept !== undefined && Date.now() - kept < ORDINARY_TTL_MS) return;
  const size = source instanceof Uint8Array ? source.length : source.size;
  if (mime !== "application/pdf" && size > 25 * 1024 * 1024) throw new PersonalDocumentRefused(`This may be a personal document, so it was not saved to shared Files. Read it with ${PERSONAL_READER_PLACE}.`);
  const onDisk = !(source instanceof Uint8Array);
  const read = await readPersonalDocument({ bytes: onDisk ? mime === "application/pdf" ? head : await readFile(source.path) : source, mime, ...(onDisk && mime === "application/pdf" ? { path: source.path } : {}) });
  if (read.privacy === "personal") throw new PersonalDocumentRefused();
  if (key) {
    ordinaryRecently.set(key, Date.now());
    if (ordinaryRecently.size > 500) ordinaryRecently.delete(ordinaryRecently.keys().next().value as string);
  }
}

/** Persist a file (bytes, or a file on disk moved in without being read)
 *  and generate image variants if applicable. Variants are made from the
 *  stored file, never from a buffer of it. Returns the metadata that becomes
 *  columns on the `files` row. */
export async function storeUpload(
  orgId: string,
  fileId: string,
  source: FileSourceIn,
  claimedMime: string,
  known?: Fingerprint,
): Promise<StoredFile> {
  await assertSharedFileSource(source, claimedMime, orgId, known);
  // The bytes' own type over whatever the upload claimed: a PDF stored under
  // a wrong type was served as a download and shown as raw bytes (#4523).
  const declaredMime = sniffType(await headOf(source)) ?? claimedMime;
  const fp = known ?? (await fingerprintOf(source));
  const sha = fp.sha256;
  const ext = extFromMime(declaredMime);
  const originalRel = `original${ext}`;
  const d = driver();
  if (source instanceof Uint8Array) await d.put(orgId, fileId, originalRel, source);
  else if (d.putFile) await d.putFile(orgId, fileId, originalRel, source.path);
  else await d.put(orgId, fileId, originalRel, await readFile(source.path));
  // What sharp reads: the stored original on local disk, else the source.
  const imageInput: Buffer | string =
    d.localPath(orgId, fileId, originalRel) ?? (source instanceof Uint8Array ? Buffer.from(source) : source.path);

  const baseKind = classifyKind(declaredMime);
  const variants: FileVariants = {
    original: { path: originalRel, bytes: fp.size },
  };

  let width: number | null = null;
  let height: number | null = null;
  let actualMime = declaredMime;

  if (baseKind === "image") {
    try {
      const meta = await sharp(imageInput, { failOn: "none" }).metadata();
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
      const medium = await sharp(imageInput, { failOn: "none" })
        .rotate() // honour EXIF orientation before resize
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      await driver().put(orgId, fileId, "medium.jpg", medium.data);
      variants.medium = {
        path: "medium.jpg",
        bytes: medium.data.length,
        width: medium.info.width,
        height: medium.info.height,
      };

      const thumb = await sharp(imageInput, { failOn: "none" })
        .rotate()
        .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      await driver().put(orgId, fileId, "thumb.jpg", thumb.data);
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
        size_bytes: fp.size,
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
    size_bytes: fp.size,
    kind: baseKind,
    width,
    height,
    mime_type: actualMime,
  };
}

/** Replace a stored original's bytes in place, same id and same path: for a
 *  text whose words must change (a store sign-in link taken out, #5461) where
 *  a new file would leave every holder of the old id pointing at the old
 *  bytes. Answers the new fingerprint for the row. */
export async function rewriteOriginalBytes(orgId: string, fileId: string, variants: FileVariants, bytes: Uint8Array): Promise<{ variants: FileVariants; sha256: string; size: number }> {
  await driver().put(orgId, fileId, variants.original.path, bytes);
  const fp = await fingerprintOf(bytes);
  return { variants: { ...variants, original: { ...variants.original, bytes: fp.size } }, sha256: fp.sha256, size: fp.size };
}

/** Best-effort: remove the file's on-disk directory. Soft-deleted
 *  rows can call this on the way to permanent purge. */
export async function removeStoredFile(orgId: string, fileId: string): Promise<void> {
  await driver().remove(orgId, fileId);
}

/** Stream a variant's bytes back to the caller. Returns the path so
 *  the route can pick between sendFile (Express built-in) and a manual
 *  stream depending on what's most convenient. */
export async function readVariant(
  orgId: string,
  fileId: string,
  variants: FileVariants,
  which: "original" | "medium" | "thumb",
): Promise<{ localPath: string | null; bytes: number } | null> {
  const v = variants[which];
  if (!v) return null;
  // localPath is non-null for the local driver (route uses sendFile), null for
  // remote drivers (route falls back to streaming readVariantBytes).
  return { localPath: driver().localPath(orgId, fileId, v.path), bytes: v.bytes };
}

/** Convenience: byte-buffer read for inline rendering / tests / remote serving. */
export async function readVariantBytes(
  orgId: string,
  fileId: string,
  variants: FileVariants,
  which: "original" | "medium" | "thumb",
): Promise<Buffer | null> {
  const v = variants[which];
  if (!v) return null;
  const b = await driver().getBytes(orgId, fileId, v.path);
  // Drivers return Uint8Array (contract); normalise to Buffer for callers
  // (Express res.send, sharp, resolvers).
  return b ? (Buffer.isBuffer(b) ? b : Buffer.from(b)) : null;
}

export function classifyKind(mime: string): FileKind {
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

/** The first bytes of a source, enough to sniff its type. */
export async function headOf(source: FileSourceIn, n = 64): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source.subarray(0, n);
  return headOfPath(source.path, n);
}

/** The first bytes of a file on disk. */
export async function headOfPath(path: string, n = 64): Promise<Uint8Array> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return new Uint8Array(0);
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
