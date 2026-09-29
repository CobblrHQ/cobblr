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
    /** An encoding that uses 0 for "not given" (a tag's chamber temperature):
     *  a 0 reads as empty, so it is never shown as 0 °C. */
    zero_is_empty: z.boolean().optional(),
    /** Paths to [r, g, b, a] arrays, a tag's colour slots in order. One set
     *  slot reads as "#rrggbb"; two or more as the platform's several-colour
     *  value (`multi(...)`, or `gradient(...)` when a `gradient_if` text says
     *  so), so every swatch draws the segments. Alpha 0 is an unused slot.
     *  Read through @cobblr/platform-contract/colour, the one colour rule. */
    colours: z.array(z.string()).max(8).optional(),
    /** Paths whose text, when it says gradient or ombre, makes several
     *  colours a gradient rather than segments. */
    gradient_if: z.array(z.string()).max(8).optional(),
    /** A path to the colour's NAME. With it, one colour (or none) reads as
     *  that name when there is one, and several colours are still the
     *  several-colour value: a colour field holds a name where one is given,
     *  because types are matched by it, and a code only where nothing named
     *  the colour. */
    named_by: z.string().optional(),
    /** The value is a [year, month, day] array: read it as "YYYY-MM-DD". */
    ymd: z.boolean().optional(),
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
    /** The vendor's own pace: at most one call per this many ms from this
     *  process, and a 429 is asked once more after it. Scans of a shelf of
     *  spools queue behind each other instead of being turned away. */
    min_interval_ms: z.number().int().nonnegative().max(60_000).optional(),
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
    /** A shared mapping for a published data format, so every maker that
     *  publishes it resolves the same way. The manifest's own name, brand,
     *  imageUrl and fields override the preset's, key by key. See ./presets.ts. */
    preset: z.enum(["opentag3d"]).optional(),
  }),
  /** sharedCache namespace; the key is the extracted `{key}`. Omit to skip caching. */
  cache_ns: z.string().max(80).optional(),
});
export type ScanUrlResolverManifest = z.infer<typeof ScanUrlResolverManifest>;
