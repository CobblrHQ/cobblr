// Declarative vendor scan-URL resolvers — the DATA shape.
//
// A scanned QR is often a maker URL encoding a specific product (a Polar
// Filament spool → `3dqr.co/?i=<id>`). Rather than a code module per vendor,
// the platform keeps a LIST of vendor manifests (built-in + operator-added) and
// one generic interpreter consults it: match the URL → pull a key out → run a
// templated fetch → map the JSON response onto a product. Adding a maker is a
// data entry, not a module. See ./interpret.ts + ./register.ts.

import { z } from "zod";

/** Map one output field from the fetched JSON. A bare string is a dotted path
 *  (relative to `response.root`); the object form adds light transforms so a
 *  vendor's raw values become tidy display values without code. */
export const FieldMap = z.union([
  z.string(),
  z.object({
    /** Dotted path into the (rooted) response object, e.g. "mass_grams". */
    path: z.string().optional(),
    /** Join several paths (truthy ones) with `sep`. */
    concat: z.array(z.string()).optional(),
    sep: z.string().optional(),
    /** Used when the resolved value is null/empty. `fallback` is for `concat`. */
    default: z.union([z.string(), z.number()]).optional(),
    fallback: z.union([z.string(), z.number()]).optional(),
    /** Numeric scale (e.g. 0.001 for g→kg) applied before prefix/suffix. */
    scale: z.number().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    /** Coerce the resolved value to a string. (Named `stringify`, not `toString`,
     *  to avoid colliding with Object.prototype.toString during validation.) */
    stringify: z.boolean().optional(),
  }),
]);
export type FieldMap = z.infer<typeof FieldMap>;

export const ScanUrlResolverManifest = z.object({
  /** Stable id (provenance + de-dup), e.g. "polar-filament". */
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  /** Claim + key-extract. `pattern` must match the URL for this vendor to fire;
   *  `key` is a regex with ONE capture group → the token threaded into the
   *  request as `{key}`. */
  match: z.object({
    pattern: z.string().min(1).max(400),
    key: z.string().min(1).max(400),
  }),
  /** The fetch. `url`/`headers`/`body` template `{key}` and `{env:VAR}`
   *  (env vars resolved at request time; `env_defaults` covers an unset var). */
  request: z.object({
    method: z.enum(["GET", "POST"]).default("GET"),
    url: z.string().min(1).max(1000),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    env_defaults: z.record(z.string()).optional(),
    timeout_ms: z.number().int().positive().max(30_000).default(8000),
  }),
  /** Validate + locate the payload. `require` = path→expected ("present" = any
   *  non-null); `require_any` = at least one path present; `root` = base path
   *  the `map`/output paths are relative to. */
  response: z.object({
    require: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    require_any: z.array(z.string()).optional(),
    root: z.string().optional(),
  }),
  /** Build the ScanUrlResolution. */
  output: z.object({
    source: z.string().min(1).max(80),
    name: FieldMap.optional(),
    brand: FieldMap.optional(),
    category: z.string().max(80).nullable().optional(),
    entityType: z.string().max(80).nullable().optional(),
    imageUrl: FieldMap.optional(),
    /** Custom fields seeded onto the created entity's metadata. */
    fields: z.record(FieldMap).default({}),
  }),
  /** sharedCache namespace; the key is the extracted `{key}`. Omit to skip caching. */
  cache_ns: z.string().max(80).optional(),
});
export type ScanUrlResolverManifest = z.infer<typeof ScanUrlResolverManifest>;
