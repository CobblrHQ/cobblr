// Declarative driver manifest — describes how to drive a REST machine
// manager (OctoPrint, Duet, Moonraker, …) as DATA, so a user installs a
// new driver without a platform deploy. The declarative engine
// (./declarative.ts) interprets one of these into a MachineDriver.
//
// Extract expressions (the `map`/`result` values):
//   "$.a.b.c"  — dot-path into the JSON response
//   "='lit'"   — a literal string
//   "={var}"   — a template var (fileId / jobId from the call args)
//
// Template vars (in `path` strings as `{var}`, and in `submit.body` string
// values as `{var}`): fileId, jobId, deviceId, tag, filename.
// See docs/modules/digifab-drivers.md.

import { z } from "zod";

const Extract = z.string().min(1);
const Method = z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET");

export const DriverManifest = z.object({
  /** Driver key — what a connection's `type` references. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  version: z.string().max(32).optional(),
  /** Header auth: send `header: <prefix?><connection field `from`>`. The
   *  optional `prefix` is prepended to the stored value — e.g. "Bearer " so a
   *  Home Assistant long-lived token goes out as `Authorization: Bearer <tok>`
   *  while the user only pastes the raw token. */
  auth: z
    .object({
      kind: z.literal("header"),
      header: z.string(),
      from: z.enum(["apiKey", "username", "password"]),
      prefix: z.string().optional(),
    })
    .nullable()
    .optional(),
  /** Whether this manager supports print-file routing (most don't). */
  routing: z.boolean().optional(),
  test: z.object({ method: Method, path: z.string() }),
  listDevices: z.object({
    method: Method,
    path: z.string(),
    /** "single" = the response IS one device; "array" = a list at arrayPath. */
    result: z.enum(["single", "array"]).default("array"),
    arrayPath: z.string().optional(),
    map: z.object({ id: Extract, name: Extract, state: Extract.optional(), enabled: Extract.optional() }),
  }),
  upload: z.object({
    method: Method,
    path: z.string(),
    /** How the file bytes are sent. "multipart" (default): a form part named
     *  `fileField`. "raw": the file bytes ARE the request body (Duet
     *  rr_upload, PrusaLink PUT) — `fileField` is then ignored and the
     *  filename usually goes in the path via {filename}. */
    body: z.enum(["multipart", "raw"]).default("multipart"),
    /** multipart field name for the file (body="multipart" only). */
    fileField: z.string().default("file"),
    /** Content-Type for body="raw" (default application/octet-stream). */
    contentType: z.string().optional(),
    result: z.object({ fileId: Extract }),
  }).optional(),
  submit: z.object({
    method: Method,
    path: z.string(),
    body: z.record(z.unknown()).optional(),
    result: z.object({ jobId: Extract, queued: Extract.optional() }),
  }).optional(),
  status: z.object({
    method: Method,
    path: z.string(),
    /** How to read the status response. "json" (default): `from`/`progress`
     *  are JSON-path/extract exprs. "text": the body is plain text (e.g. a
     *  GRBL `<Idle|MPos:..>` report) and `from`/`progress` are REGEXES whose
     *  first capture group is the value. */
    parse: z.enum(["json", "text"]).default("json"),
    result: z.object({
      state: z.object({ from: Extract, map: z.record(z.string()) }),
      progress: Extract.optional(),
    }),
  }).optional(),
  /** OPTIONAL — the ACTUATOR shape. Maps a command NAME to an outbound HTTP
   *  request. `{param}` placeholders in `path` + in `body` string-values are
   *  filled from the command's params (the wire's per-entity args). No file, no
   *  job — fire and ack. A manifest may carry commands ALONGSIDE the fabrication
   *  sections, or commands-only (omit upload/submit/status) for a pure actuator. */
  commands: z
    .record(
      z.object({
        method: Method,
        path: z.string(),
        body: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
});

export type DriverManifest = z.infer<typeof DriverManifest>;
