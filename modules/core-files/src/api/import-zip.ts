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
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import { platform, uploadOne } from "@cobblr/platform-contract";
import { tooLargeMessage, uploadedFile } from "@cobblr/platform-contract/upload";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { ensureFolderPath, intakeFile, resolveTarget, sameBytes } from "./intake.js";
import { bytesUsed, QUOTA_BYTES, quotaDecision } from "./quota.js";

export const importZipRouter = Router({ mergeParams: true });

export const UNPACKED_MAX_BYTES = 1024 * 1024 * 1024;
export const ENTRIES_MAX = 2000;

// A zip may be as big as the biggest file this deployment takes; each entry
// is then judged like a single upload of it (PDFs and design files by the
// deployment's own limit, everything else 25 MB).
const upload = uploadOne({ maxBytes: "largest", noun: "zip" });

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
  | { path: string; filename: string; status: "too_big"; bytes: number; reason: string }
  | { path: string; filename: string; status: "failed"; reason: string };

// AI-REACH: exempt — takes a file (a zip archive, multipart), which an action cannot carry
// UI-SCREEN: /files
importZipRouter.post(
  "/",
  upload,
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const ctx = tenantContext(req);
    const userId = sessionUser(req)?.id ?? null;
    const file = uploadedFile(req);
    if (!file) {
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

    // Read the directory first, from the zip on disk: sizes as the zip
    // declares them, nothing inflated yet. Each entry is inflated on its own
    // when its turn comes, so the archive is never in memory whole.
    type Entry = unzipper.File;
    const wanted: Entry[] = [];
    const tooBig: ImportLine[] = [];
    let total = 0;
    let entries = 0;
    try {
      const dir = await unzipper.Open.file(file.path);
      for (const f of dir.files) {
        if (f.type !== "File" || f.path.endsWith("/") || isJunk(f.path)) continue;
        entries += 1;
        const name = f.path.split("/").pop() ?? f.path;
        const row = platform().http.uploadSizeFor(name, mimeFor(name));
        if (f.uncompressedSize > row.maxBytes) {
          tooBig.push({ path: f.path, filename: name, status: "too_big", bytes: f.uncompressedSize, reason: tooLargeMessage(f.uncompressedSize, row.maxBytes, "file", row.label) });
          continue;
        }
        total += f.uncompressedSize;
        wanted.push(f);
      }
    } catch {
      res.status(400).json({ error: { code: "not_a_zip", message: "That file could not be opened as a .zip." } });
      return;
    }
    if (entries > ENTRIES_MAX || total > UNPACKED_MAX_BYTES) {
      const message = `A zip can hold up to ${ENTRIES_MAX} files and ${Math.round(UNPACKED_MAX_BYTES / 1024 / 1024)} MB unpacked; this one has ${entries} files and ${Math.round(total / 1024 / 1024)} MB. Split it and import the parts.`;
      platform().http.uploadRefused(req, { reason: "zip_too_large", sizeBytes: total, limitBytes: UNPACKED_MAX_BYTES, mimeType: file.mimetype, message });
      res.status(413).json({ error: { code: "zip_too_large", message } });
      return;
    }

    // The whole archive is one upload for the plan's allowance and the
    // workspace's quota, judged before a single file is stored.
    const used = await bytesUsed(db);
    const ent = await platform().entitlements.check({ orgId: ctx.org.id, feature: "files.upload", userId: userId ?? undefined, quantity: total, used });
    if (!ent.allow) {
      const message = ent.reason ?? "File uploads aren't available on your plan.";
      platform().http.uploadRefused(req, { reason: "plan_limit", sizeBytes: total, mimeType: file.mimetype, message });
      res.status(402).json({ error: { code: "plan_limit", message } });
      return;
    }
    const room = quotaDecision(used, total, QUOTA_BYTES);
    if (!room.allow) {
      platform().http.uploadRefused(req, { reason: "storage_full", sizeBytes: total, limitBytes: QUOTA_BYTES, mimeType: file.mimetype, message: room.reason ?? "This workspace's storage is full." });
      res.status(413).json({ error: { code: "storage_full", message: room.reason } });
      return;
    }

    const cache = new Map<string, string | null>();
    const lines: ImportLine[] = [];
    const spent: string[] = [];
    try {
      for (const entry of wanted.sort((a, b) => a.path.localeCompare(b.path))) {
        const path = entry.path;
        const parts = path.split("/").filter(Boolean);
        const filename = parts.pop() ?? path;
        try {
          const folderId = await ensureFolderPath(db, target, parts, cache);
          // One entry at a time, inflated to disk beside the zip and hashed on
          // the way, never held whole.
          const at = `${file.path}.${spent.length}`;
          spent.push(at);
          const unpacked = await unpackEntry(entry, at, platform().http.uploadSizeFor(filename, mimeFor(filename)).maxBytes);
          const fingerprint = { sha256: unpacked.sha256, size: unpacked.size };
          const same = await sameBytes(db, fingerprint);
          if (same) {
            lines.push({ path, filename, status: "duplicate", file_id: same.id, folder_id: same.folder_id, mime_type: same.mime_type, existing_filename: same.filename, existing_folder: same.folder_names });
            continue;
          }
          const { row } = await intakeFile(db, ctx.org.id, userId, { source: unpacked, fingerprint, filename, mime: mimeFor(filename), folderId });
          lines.push({ path, filename, status: "stored", file_id: row.id, folder_id: row.folder_id, mime_type: row.mime_type });
        } catch (err) {
          lines.push({ path, filename, status: "failed", reason: (err as Error).message.slice(0, 200) });
        }
      }
    } finally {
      await Promise.all(spent.map((p) => rm(p, { force: true })));
    }
    lines.push(...tooBig);
    const count = (s: ImportLine["status"]) => lines.filter((l) => l.status === s).length;
    res.json({ stored: count("stored"), duplicates: count("duplicate"), too_big: count("too_big"), failed: count("failed"), lines });
  }),
);

/** One zip entry to a file of its own, hashed as it inflates, and stopped at
 *  `limit`: the size the zip declares for an entry is only a claim, and a
 *  bomb lies about it. */
async function unpackEntry(entry: unzipper.File, path: string, limit: number): Promise<{ path: string; size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > limit) return done(new Error(`unpacks to more than the ${Math.round(limit / 1024 / 1024)} MB it can be`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(entry.stream(), meter, createWriteStream(path, { flags: "wx" }));
  return { path, size, sha256: hash.digest("hex") };
}
