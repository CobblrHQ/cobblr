// Declarative driver manifest — describes how to drive a REST machine
// manager (OctoPrint, Duet, Moonraker, …) as DATA, so a user installs a
// new driver without a platform deploy. The declarative engine
// (./declarative.ts) interprets one of these into a MachineDriver.
//
// Extract expressions (the `map`/`result` values):
//   "$.a.b.c"  — dot-path into the JSON response
//   "='lit'"   — a literal string
//   "={var}"   — a template var (fileId / jobId from the call args)
// See docs/design-decisions/digifab-drivers.md.

import { z } from "zod";

const Extract = z.string().min(1);
const Method = z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET");

export const DriverManifest = z.object({
  /** Driver key — what a connection's `type` references. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  version: z.string().max(32).optional(),
  /** Header auth: send `header: <connection field `from`>`. */
  auth: z
    .object({ kind: z.literal("header"), header: z.string(), from: z.enum(["apiKey", "username", "password"]) })
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
    /** multipart field name for the file. */
    fileField: z.string().default("file"),
    result: z.object({ fileId: Extract }),
  }),
  submit: z.object({
    method: Method,
    path: z.string(),
    body: z.record(z.unknown()).optional(),
    result: z.object({ jobId: Extract, queued: Extract.optional() }),
  }),
  status: z.object({
    method: Method,
    path: z.string(),
    result: z.object({
      state: z.object({ from: Extract, map: z.record(z.string()) }),
      progress: Extract.optional(),
    }),
  }),
});

export type DriverManifest = z.infer<typeof DriverManifest>;
