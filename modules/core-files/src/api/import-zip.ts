// POST /files/import-zip — a whole folder of files in one go (#3753 P2b).
//
// A knitter's rescued patterns arrive as a downloads folder: zip it, drop
// it, and it lands as it was, "Patterns/Blankets/granny.pdf" in a Patterns
// folder holding a Blankets folder, under the folder she is looking at.
// Every file goes through the same intake as a single upload (the same
// bytes are kept once), and the answer is a line per file, so nothing is
// dropped without saying so.
//
// Guarded like any archive from a stranger: each entry's size is read from
// the zip's own directory before anything is inflated, so a small zip that
// unpacks to gigabytes is refused before it costs memory, and there is a
// cap on how many entries and how much in total.

import { Router } from "express";
import multer from "multer";
import { unzipSync } from "fflate";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { ensureFolderPath, intakeFile, resolveTarget, sameBytes } from "./intake.js";
import { bytesUsed, QUOTA_BYTES, quotaDecision } from "./quota.js";

export const importZipRouter = Router({ mergeParams: true });

/** One file's ceiling, the same as a single upload. */
export const ENTRY_MAX_BYTES = 25 * 1024 * 1024;
export const ZIP_MAX_BYTES = 200 * 1024 * 1024;
export const UNPACKED_MAX_BYTES = 1024 * 1024 * 1024;
export const ENTRIES_MAX = 2000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ZIP_MAX_BYTES, files: 1 } });

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  stl: "model/stl",
  "3mf": "model/3mf",
  zip: "application/zip",
};
export function mimeFor(name: string): string {
  return MIME[(name.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
}

/** An archive's own furniture, never a person's file: macOS resource forks
 *  and Finder files, Windows thumbnails, hidden files. */
export function isJunk(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? "";
  return parts.some((p) => p === "__MACOSX" || p.startsWith(".")) || base === "Thumbs.db" || base === "desktop.ini";
}

/** One line per file, the same shape the web intake reports for a plain
 *  upload (platform-web IntakeLine): a duplicate carries the file already
 *  holding those bytes, so a caller can link to it instead of skipping. */
export type ImportLine =
  | { path: string; filename: string; status: "stored"; file_id: string; folder_id: string | null; mime_type: string }
  | { path: string; filename: string; status: "duplicate"; file_id: string; folder_id: string | null; mime_type: string; existing_filename: string; existing_folder: string[] }
  | { path: string; filename: string; status: "too_big"; bytes: number }
  | { path: string; filename: string; status: "failed"; reason: string };

// AI-REACH: exempt — takes a file (a zip archive, multipart), which an action cannot carry
importZipRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file?.buffer) {
      res.status(400).json({ error: { code: "missing_file", message: "Multipart field 'file' (a .zip) is required." } });
      return;
    }
    const db = tenantDb(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : null);
    const resolved = await resolveTarget(db, field("folder_id"), field("folder_path"));
    if (resolved === "missing") {
      res.status(404).json({ error: { code: "folder_not_found", message: "That folder does not exist any more." } });
      return;
    }
    const target = resolved;

    // Read the directory first: sizes as the zip declares them, nothing
    // inflated yet.
    const wanted: Array<{ path: string; size: number }> = [];
    const tooBig: ImportLine[] = [];
    let total = 0;
    let entries = 0;
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(new Uint8Array(file.buffer), {
        filter: (f) => {
          if (f.name.endsWith("/") || isJunk(f.name)) return false;
          entries += 1;
          if (f.originalSize > ENTRY_MAX_BYTES) {
            tooBig.push({ path: f.name, filename: f.name.split("/").pop() ?? f.name, status: "too_big", bytes: f.originalSize });
            return false;
          }
          total += f.originalSize;
          wanted.push({ path: f.name, size: f.originalSize });
          return entries <= ENTRIES_MAX && total <= UNPACKED_MAX_BYTES;
        },
      });
    } catch {
      res.status(400).json({ error: { code: "not_a_zip", message: "That file could not be opened as a .zip." } });
      return;
    }
    if (entries > ENTRIES_MAX || total > UNPACKED_MAX_BYTES) {
      res.status(413).json({
        error: {
          code: "zip_too_large",
          message: `A zip can hold up to ${ENTRIES_MAX} files and ${Math.round(UNPACKED_MAX_BYTES / 1024 / 1024)} MB unpacked; this one has ${entries} files and ${Math.round(total / 1024 / 1024)} MB. Split it and import the parts.`,
        },
      });
      return;
    }

    // The whole archive is one upload for the plan's allowance and the
    // workspace's quota, judged before a single file is stored.
    const used = await bytesUsed(db);
    const ent = await platform().entitlements.check({ orgId: ctx.org.id, feature: "files.upload", userId: userId ?? undefined, quantity: total, used });
    if (!ent.allow) {
      res.status(402).json({ error: { code: "plan_limit", message: ent.reason ?? "File uploads aren't available on your plan." } });
      return;
    }
    const room = quotaDecision(used, total, QUOTA_BYTES);
    if (!room.allow) {
      res.status(413).json({ error: { code: "storage_full", message: room.reason } });
      return;
    }

    const cache = new Map<string, string | null>();
    const lines: ImportLine[] = [];
    for (const { path } of wanted.sort((a, b) => a.path.localeCompare(b.path))) {
      const bytes = unzipped[path];
      if (!bytes) continue;
      const parts = path.split("/").filter(Boolean);
      const filename = parts.pop() ?? path;
      try {
        const folderId = await ensureFolderPath(db, target, parts, cache);
        const buffer = Buffer.from(bytes);
        const same = await sameBytes(db, buffer);
        if (same) {
          lines.push({ path, filename, status: "duplicate", file_id: same.id, folder_id: same.folder_id, mime_type: same.mime_type, existing_filename: same.filename, existing_folder: same.folder_names });
          continue;
        }
        const { row } = await intakeFile(db, ctx.org.id, userId, { buffer, filename, mime: mimeFor(filename), folderId });
        lines.push({ path, filename, status: "stored", file_id: row.id, folder_id: row.folder_id, mime_type: row.mime_type });
      } catch (err) {
        lines.push({ path, filename, status: "failed", reason: (err as Error).message.slice(0, 200) });
      }
    }
    lines.push(...tooBig);
    const count = (s: ImportLine["status"]) => lines.filter((l) => l.status === s).length;
    res.json({ stored: count("stored"), duplicates: count("duplicate"), too_big: count("too_big"), failed: count("failed"), lines });
  }),
);
