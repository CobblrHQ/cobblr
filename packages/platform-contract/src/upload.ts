// Uploads: how big a file may be, what a refused one is called, and the one
// sentence that says it.
//
// Every multipart route takes its file through platform().http.upload (the
// kernel's one upload door, the only place multer is used;
// lint:uploads-through-one-door holds that). The door streams the file to a
// temporary file on disk, hashing it as it arrives, so no upload is ever held
// whole in the api's memory; a route reads it as `uploadedFile(req)`.
//
// A refusal there, or one a route makes itself after reading the file (a full
// workspace), answers with a code from this list, the file's size and the
// limit, and writes the same facts to the server log: never the file's name
// or its bytes, which are the person's.
//
// The size limits live here, one row per kind of file, so the door, the
// proxy in front of it (lint:proxy-body-limit-follows-uploads) and a page
// that words a refusal itself cannot disagree.

export const UPLOAD_REFUSALS = [
  "file_too_large",
  "too_many_files",
  "unexpected_field",
  "storage_full",
  "plan_limit",
  "zip_too_large",
  "type_refused",
  "malformed",
  // The page saw the connection drop before an answer came (a proxy's own
  // limit, a phone losing signal) and reported it; the server never had the file.
  "connection_lost",
] as const;
export type UploadRefusalCode = (typeof UPLOAD_REFUSALS)[number];

const MB = 1024 * 1024;

export interface UploadSizeRow {
  group: "design" | "other";
  /** How a refusal names the group: "PDFs and design files can be up to 200 MB". */
  label: string;
  maxBytes: number;
  /** Extensions in the group, lower case, without the dot. Empty: every file
   *  no other row claims. */
  extensions: readonly string[];
  /** Declared types that confirm an extension (with the generic
   *  application/octet-stream and an empty type, which phones send for many
   *  of these). A file whose declared type says otherwise (a video named
   *  .pdf) is not in the group. */
  types: readonly string[];
}

/** The design row's limit unless a deployment sets its own
 *  (COBBLR_UPLOAD_DESIGN_MAX_MB): the owner's call (2026-09-30), since pattern
 *  PDFs and CAD/print files are routinely past 25 MB. A deployment behind a
 *  proxy with a smaller request cap sets it lower (the hosted app: 100 MB). */
export const DEFAULT_DESIGN_UPLOAD_MAX_BYTES = 200 * MB;
/** Every file no other row claims, on every deployment. */
export const GENERAL_UPLOAD_MAX_BYTES = 25 * MB;

/** One table, one place: the rows for a deployment whose design files may be
 *  up to `designMaxBytes`. */
export function uploadSizePolicy(designMaxBytes: number = DEFAULT_DESIGN_UPLOAD_MAX_BYTES): readonly UploadSizeRow[] {
  return [
    {
      group: "design",
      label: "PDFs and design files",
      maxBytes: designMaxBytes,
      extensions: ["pdf", "step", "stp", "stl", "3mf", "obj", "amf", "gcode", "gco", "bgcode", "dxf", "svg"],
      types: [
        "application/pdf",
        "model/step",
        "application/step",
        "application/stp",
        "model/stl",
        "application/sla",
        "application/vnd.ms-pki.stl",
        "model/3mf",
        "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
        "model/obj",
        "text/plain",
        "application/x-amf",
        "text/x.gcode",
        "text/x-gcode",
        "application/x-gcode",
        "image/vnd.dxf",
        "application/dxf",
        "image/svg+xml",
      ],
    },
    { group: "other", label: "Files", maxBytes: GENERAL_UPLOAD_MAX_BYTES, extensions: [], types: [] },
  ];
}

/** The default deployment's rows (a self-hosted instance). */
export const UPLOAD_SIZE_POLICY: readonly UploadSizeRow[] = uploadSizePolicy();

/** The largest one file may be under a policy: what a zip may be, since it
 *  carries files. */
export function largestUploadBytes(policy: readonly UploadSizeRow[] = UPLOAD_SIZE_POLICY): number {
  return Math.max(...policy.map((r) => r.maxBytes));
}

/** The largest body a route may accept, a backup archive's included: what a
 *  proxy in front of the api must let through (lint:proxy-body-limit-follows-uploads).
 *  The door refuses a route cap above it, and a design limit above it refuses
 *  boot, so this is a true ceiling. */
export const UPLOAD_CEILING_BYTES = 1024 * MB;

/** The row a file falls in, by its extension and declared type together. */
export function uploadSizeRowFor(
  filename: string | null | undefined,
  mimeType: string | null | undefined,
  policy: readonly UploadSizeRow[] = UPLOAD_SIZE_POLICY,
): UploadSizeRow {
  const ext = (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const type = (mimeType ?? "").toLowerCase().split(";")[0]!.trim();
  const generic = type === "" || type === "application/octet-stream";
  for (const row of policy) {
    if (row.extensions.length === 0) continue;
    if (row.extensions.includes(ext) && (generic || row.types.includes(type))) return row;
  }
  return policy.find((r) => r.extensions.length === 0)!;
}

export interface UploadOptions {
  personalDocument?: true;
  /** A route's own cap, in bytes (a backup, an image). "largest": the most
   *  any one file may be on this deployment (a zip of files). Absent: each
   *  file's limit comes from this deployment's size policy by its kind. Never
   *  above UPLOAD_CEILING_BYTES. */
  maxBytes?: number | "largest";
  /** The multipart field the file arrives in. Default "file". */
  field?: string;
  /** What the route calls the thing, for the message ("backup", "zip"). Default "file". */
  noun?: string;
}

/** The file the door wrote, as a route reads it. There is no `buffer`: the
 *  bytes are on disk at `path` until the response is done, then removed. */
export interface UploadedFile {
  path: string;
  size: number;
  /** sha256 of the bytes, hex, taken as they arrived. */
  sha256: string;
  originalname: string;
  mimetype: string;
}

/** The uploaded file on this request, or null when none came. */
export function uploadedFile(req: unknown): UploadedFile | null {
  const f = (req as { file?: Partial<UploadedFile> } | null)?.file;
  if (!f || typeof f.path !== "string" || typeof f.sha256 !== "string") return null;
  return { path: f.path, size: Number(f.size) || 0, sha256: f.sha256, originalname: f.originalname ?? "", mimetype: f.mimetype ?? "application/octet-stream" };
}

/** An express-shaped middleware, typed without express so the contract stays
 *  free of it. */
export type UploadMiddleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => void;

export interface UploadRefusal {
  reason: UploadRefusalCode;
  /** The file's size as far as it is known: the request's declared length,
   *  or the bytes read when it stopped. Null when neither is known. */
  sizeBytes?: number | null;
  limitBytes?: number | null;
  /** The type the browser declared for the file. */
  mimeType?: string | null;
  /** The route the upload was for, when the refusal is reported from
   *  elsewhere (the page, for a connection that dropped). Default: this
   *  request's own route. Logged as a pattern, without ids or the slug. */
  route?: string;
  message: string;
}

/** "31.2 MB", "25 MB", "900 KB": one decimal only when it says something. */
export function megabytes(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} MB`;
}

/** "This file is about 31 MB; the most one file can be is 25 MB.", or, for a
 *  group with a name of its own, "This file is about 230 MB; PDFs and design
 *  files can be up to 200 MB." */
export function tooLargeMessage(sizeBytes: number | null | undefined, limitBytes: number, noun = "file", groupLabel?: string): string {
  const limit = megabytes(limitBytes);
  const over = sizeBytes && sizeBytes > limitBytes ? `This ${noun} is about ${megabytes(sizeBytes)}` : `This ${noun} is over ${limit}`;
  if (groupLabel && groupLabel !== "Files") return `${over}; ${groupLabel} can be up to ${limit}.`;
  return sizeBytes && sizeBytes > limitBytes ? `${over}; the most one ${noun} can be is ${limit}.` : `${over}, the most one ${noun} can be.`;
}

/** What the page says when the connection dropped before any answer. */
export const CONNECTION_LOST_MESSAGE = "The upload was cut off before it arrived. Try again on a steadier connection.";
