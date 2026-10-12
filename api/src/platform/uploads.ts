import { trueType } from "@cobblr/platform-contract/sniff-type";
import { PERSONAL_READER_PLACE, readPersonalDocument } from "@cobblr/platform-contract/personal-documents";
import { uploadedFile } from "@cobblr/platform-contract/upload";
// The one upload door (platform().http.upload, @cobblr/platform-contract/upload).
//
// Every multipart route takes its file through here, and this is the only
// file that uses multer (lint:uploads-through-one-door). Two things it is for:
//
// 1. A refusal a person can act on. A file over its limit used to answer 500
//    "internal error": multer's LIMIT_FILE_SIZE was an unhandled error on every
//    route that used it. Now a refusal answers 413 (too large) or 400 (too many
//    files, the wrong field, a malformed body) with its code, the file's size
//    and the limit, and writes one log line of the facts: workspace, person,
//    route, declared type, size, reason, limit, browser. Never the file's name
//    or bytes: those are the person's.
//
// 2. No upload held whole in memory. The file streams to a temporary file
//    under the files root (never /tmp, which is RAM on some hosts), hashed as
//    it arrives, and its size limit is applied as the bytes arrive, by its kind
//    (UPLOAD_SIZE_POLICY: PDFs and design files 200 MB, everything else 25 MB)
//    unless the route has its own cap. A route reads it as uploadedFile(req)
//    and moves or streams it into the file store. When the response is done,
//    for any reason (sent, failed, the person cancelled), what is left of the
//    temporary file is removed; a sweep clears any a crash left behind.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import {
  UPLOAD_CEILING_BYTES,
  largestUploadBytes,
  tooLargeMessage,
  uploadSizePolicy,
  uploadSizeRowFor,
  type UploadMiddleware,
  type UploadOptions,
  type UploadRefusal,
  type UploadSizeRow,
} from "@cobblr/platform-contract/upload";
import { env } from "../env.js";

const DECLARED_TYPE = Symbol("upload.declaredType");
const TEMP_PATHS = Symbol("upload.tempPaths");
const TOO_LARGE = Symbol("upload.tooLarge");

type TooLarge = { limitBytes: number; label: string; readBytes: number };
type Req = Request & {
  [DECLARED_TYPE]?: string;
  [TEMP_PATHS]?: string[];
  [TOO_LARGE]?: TooLarge;
  tenant?: { org?: { id?: string } };
  session?: { id?: string };
};

/** This deployment's size rows: the design-file limit is its own setting
 *  (COBBLR_UPLOAD_DESIGN_MAX_MB), everything else 25 MB everywhere. */
export function deploymentUploadPolicy(designMaxMb: number = env.COBBLR_UPLOAD_DESIGN_MAX_MB): readonly UploadSizeRow[] {
  return uploadSizePolicy(designMaxMb * 1024 * 1024);
}

/** The row a file falls in on this deployment. */
export function uploadSizeFor(filename: string, mimeType: string | null): UploadSizeRow {
  return uploadSizeRowFor(filename, mimeType, deploymentUploadPolicy());
}

/** Where uploads land while a request is in flight: beside the files they
 *  become (the same disk, so moving one in is a rename), never /tmp. */
export function uploadTempDir(): string {
  if (process.env.COBBLR_UPLOAD_TMP) return resolve(process.env.COBBLR_UPLOAD_TMP);
  const root = process.env.COBBLR_FILES_ROOT
    ? resolve(process.env.COBBLR_FILES_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "_files");
  return join(root, ".upload-tmp");
}

/** The size as far as it is known when an upload stops: the request's own
 *  declared length (the multipart body, a few hundred bytes over the file). */
function declaredSize(req: Request): number | null {
  const n = Number(req.headers["content-length"]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The route as a pattern: no ids, and no workspace slug (a slug is often a
 *  person's name; the workspace id beside it already says which). */
function routeOf(req: Request, reported?: string): string {
  const path = reported ?? `${req.baseUrl ?? ""}${(req.route as { path?: string } | undefined)?.path ?? req.path ?? ""}`;
  return path
    .split("?")[0]!
    .replace(/\/orgs\/[^/]+/, "/orgs/:slug")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/+$/, "");
}

/** One line per refused upload, the same shape from the door and from a
 *  route that refuses after it. */
export function logUploadRefused(req: unknown, refusal: UploadRefusal): void {
  const r = req as Req;
  const line = {
    reason: refusal.reason,
    size_bytes: refusal.sizeBytes ?? null,
    limit_bytes: refusal.limitBytes ?? null,
    mime_type: refusal.mimeType ?? r[DECLARED_TYPE] ?? null,
    org_id: r.tenant?.org?.id ?? null,
    user_id: r.session?.id ?? null,
    route: routeOf(r, refusal.route),
    method: r.method,
    user_agent: String(r.headers?.["user-agent"] ?? "").slice(0, 300) || null,
  };
  console.warn(`[upload] refused ${JSON.stringify(line)}`);
}

/** The storage engine: each file to its own temporary file, hashed and sized
 *  as it streams, stopped the moment it passes its limit. */
function diskEngine(routeCap: number | undefined, policy: readonly UploadSizeRow[]): multer.StorageEngine {
  return {
    _handleFile(req, file, cb) {
      const rq = req as Req;
      rq[DECLARED_TYPE] = file.mimetype;
      const row = uploadSizeRowFor(file.originalname, file.mimetype, policy);
      const limit = routeCap ?? row.maxBytes;
      const label = routeCap ? "" : row.label;
      const dir = uploadTempDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${randomUUID()}.part`);
      (rq[TEMP_PATHS] ??= []).push(path);
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (size > limit) {
            rq[TOO_LARGE] = { limitBytes: limit, label, readBytes: size };
            done(new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname));
            return;
          }
          hash.update(chunk);
          done(null, chunk);
        },
      });
      pipeline(file.stream, meter, createWriteStream(path, { flags: "wx" }))
        .then(() => cb(null, { path, size, sha256: hash.digest("hex") } as Partial<Express.Multer.File>))
        .catch((err: unknown) => {
          // The rest of this file is never read: let the parser move on.
          file.stream.resume();
          void rm(path, { force: true });
          cb(err instanceof Error ? err : new Error(String(err)));
        });
    },
    _removeFile(_req, file, cb) {
      rm(file.path, { force: true }).then(() => cb(null), cb);
    },
  };
}

function refusalFor(err: multer.MulterError, req: Req, opts: UploadOptions & { maxBytes?: number }): { status: number; refusal: UploadRefusal } {
  const noun = opts.noun ?? "file";
  const mimeType = req[DECLARED_TYPE] ?? null;
  switch (err.code) {
    case "LIMIT_FILE_SIZE": {
      const over = req[TOO_LARGE];
      const limit = over?.limitBytes ?? opts.maxBytes ?? UPLOAD_CEILING_BYTES;
      const size = Math.max(declaredSize(req) ?? 0, over?.readBytes ?? 0) || null;
      return { status: 413, refusal: { reason: "file_too_large", sizeBytes: size, limitBytes: limit, mimeType, message: tooLargeMessage(size, limit, noun, over?.label || undefined) } };
    }
    case "LIMIT_FILE_COUNT":
      return { status: 400, refusal: { reason: "too_many_files", sizeBytes: declaredSize(req), limitBytes: opts.maxBytes ?? null, mimeType, message: `Send one ${noun} at a time.` } };
    case "LIMIT_UNEXPECTED_FILE":
      return { status: 400, refusal: { reason: "unexpected_field", sizeBytes: declaredSize(req), limitBytes: opts.maxBytes ?? null, mimeType, message: `The ${noun} goes in the "${opts.field ?? "file"}" field.` } };
    default:
      return { status: 400, refusal: { reason: "malformed", sizeBytes: declaredSize(req), limitBytes: opts.maxBytes ?? null, mimeType, message: `The upload could not be read (${err.code.toLowerCase().replace(/_/g, " ")}). Try again.` } };
  }
}

/** The door: one file, streamed to disk, its limit applied as it arrives,
 *  every refusal answered and logged the same way, nothing left behind. */
export function uploadMiddleware(options: UploadOptions): UploadMiddleware {
  const policy = deploymentUploadPolicy();
  const routeCap = options.maxBytes === "largest" ? largestUploadBytes(policy) : options.maxBytes;
  const opts = { ...options, maxBytes: routeCap };
  if (routeCap !== undefined && routeCap > UPLOAD_CEILING_BYTES) {
    throw new Error(`an upload route's cap (${routeCap} bytes) is above UPLOAD_CEILING_BYTES, which the proxy is sized to`);
  }
  const field = opts.field ?? "file";
  const parse = multer({
    storage: diskEngine(routeCap, policy),
    // The hard stop; each file's own limit is applied by the engine.
    limits: { fileSize: routeCap ?? UPLOAD_CEILING_BYTES, files: 1 },
  }).single(field);
  return (req, res, next) => {
    const rq = req as Req;
    const rs = res as Response;
    // Whatever happens next, the temporary file does not outlive the request.
    rs.once("close", () => {
      for (const p of rq[TEMP_PATHS] ?? []) void rm(p, { force: true });
    });
    parse(rq, rs, ((err?: unknown) => {
      if (!err) {
        const file = uploadedFile(rq);
        const orgId = rq.tenant?.org?.id;
        if (!file || opts.personalDocument || !orgId) return next();
        (async () => {
          const handle = await open(file.path, "r");
          const head = Buffer.alloc(4096);
          let length: number;
          try { length = (await handle.read(head, 0, head.length, 0)).bytesRead; } finally { await handle.close(); }
          const mime = trueType(head.subarray(0, length), file.mimetype);
          if (!/^(?:image\/|application\/pdf|text\/)/.test(mime)) return next();
          if (file.size > 25 * 1024 * 1024 && mime !== "application/pdf") {
            rs.status(409).json({ error: { code: "personal_document", message: `This document is too large to check privately here. Keep your copy and use a PDF or photo under 25 MB with ${PERSONAL_READER_PLACE}.` } });
            return;
          }
          const read = await readPersonalDocument({ bytes: mime === "application/pdf" ? head.subarray(0, length) : await readFile(file.path), mime, assist: { orgId, userId: rq.session?.id }, ...(mime === "application/pdf" ? { path: file.path } : {}) });
          if (read.privacy === "normal") return next();
          rs.setHeader("Cache-Control", "no-store");
          rs.status(409).json({ error: { code: "personal_document", message: `This is a personal document. It has not been saved to shared Files or sent to a cloud AI; read it with ${PERSONAL_READER_PLACE}.`, details: read } });
        })().catch(next);
        return;
      }
      if (err instanceof multer.MulterError) {
        const { status, refusal } = refusalFor(err, rq, opts);
        logUploadRefused(rq, refusal);
        rs.status(status).json({
          error: { code: refusal.reason, message: refusal.message, size_bytes: refusal.sizeBytes ?? null, limit_bytes: refusal.limitBytes ?? null },
        });
        return;
      }
      next(err);
    }) as NextFunction);
  };
}

/** A backstop for temporary files a crash left behind (the process died
 *  between the write and the response). Anything older than an hour is from
 *  no request still in flight. */
export async function sweepStaleUploads(maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const dir = uploadTempDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    // `<id>.part`, and what a route unpacked beside it (`<id>.part.<n>`).
    if (!/\.part(\.\d+)?$/.test(name)) continue;
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (now - s.mtimeMs > maxAgeMs) {
        await rm(p, { force: true });
        removed++;
      }
    } catch {
      // gone already
    }
  }
  if (removed) console.warn(`[upload] swept ${removed} stale temporary upload(s)`);
  return removed;
}

let sweepHandle: NodeJS.Timeout | null = null;

/** Sweep at boot (a crash's leftovers from the last process) and hourly. */
export function startStaleUploadSweeper(): void {
  const tick = () => void sweepStaleUploads().catch((err: unknown) => console.warn(`[upload] stale sweep failed: ${(err as Error).message}`));
  if (sweepHandle) clearInterval(sweepHandle);
  // SINGLE-PROCESS-SAFE: it removes only temporary files an hour old, which
  // no request in any process still owns, and a file two processes both try
  // to remove is removed once (rm with force).
  sweepHandle = setInterval(tick, 60 * 60 * 1000);
  sweepHandle.unref?.();
  tick();
}
