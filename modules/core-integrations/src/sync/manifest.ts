// Declarative sync-source manifest — describes how to mirror an external HTTP
// API's entities into Cobblr as DATA, so a user adds a sync source (a self-hosted
// inventory app, a Notion DB, a sheet, …) by INSTALLING a manifest — no platform deploy, nothing
// source-specific compiled into the kernel. The declarative engine
// (./declarative.ts) interprets one of these into a SyncConnector.
//
// This mirrors digifab's declarative machine-driver manifests
// (modules/digifab/src/drivers/manifest.ts) — same idea, applied to entity sync.
//
// Field-map value grammar (a FieldSpec, recursive):
//   "$.a.b.c"                              — dot-path into the source record
//   "='literal'"                           — a literal string
//   { from, valueMap?, default? }          — read `from`, optionally remap the
//                                            value via valueMap, else `default`
//   { object: { k: FieldSpec, … } }        — a nested object (e.g. metadata)
//
// See docs/modules/sync-sources.md.

import { z } from "zod";

/** A dot-path (`$.x.y`) or literal (`='lit'`) string extract. */
const Extract = z.string().min(1);
const Method = z.enum(["GET", "POST"]).default("GET");

/** A field mapping value — recursive (nested objects + value remaps + fallbacks). */
export type FieldSpec =
  | string
  | { from: string; valueMap?: Record<string, string>; default?: unknown }
  | { object: Record<string, FieldSpec> }
  | { coalesce: FieldSpec[] };

export const FieldSpec: z.ZodType<FieldSpec> = z.lazy(() =>
  z.union([
    Extract,
    z.object({
      from: Extract,
      valueMap: z.record(z.string()).optional(),
      default: z.unknown().optional(),
    }),
    z.object({ object: z.record(FieldSpec) }),
    // First sub-spec that yields a non-null/non-empty value wins — a fallback
    // chain (e.g. name = the item's name, else the yarn's name, else "Yarn").
    z.object({ coalesce: z.array(FieldSpec).min(1) }),
  ]),
);

export const SyncEntityTypeManifest = z.object({
  /** Stable key for this entity type, e.g. "locations". */
  key: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  /** The Cobblr entity kind to write into, e.g. "core-locations:location". */
  targetKind: z.string().min(1).max(120),
  /** For a multi-instance target (e.g. machines): the instance slug to land rows
   *  in, so they show under that nav entry — e.g. "3d-printers". Omit for the base. */
  targetInstance: z.string().max(60).optional(),
  /** Route EACH row to an instance by a field value, so ONE section fans a single
   *  endpoint out to several instances (e.g. an inventory API's /printers → 3d-printers +
   *  laser-cutters + cnc by category). A value not in `map` is skipped unless
   *  `default` is set. Subsumes filter+targetInstance for the fan-out case.
   *  e.g. { "from": "$.category", "map": { "printer": "3d-printers", "laser": "laser-cutters" } } */
  instanceBy: z
    .object({
      from: Extract,
      map: z.record(z.string().max(60)),
      default: z.string().max(60).optional(),
    })
    .optional(),
  /** List endpoint (fetchAll). `arrayPath` points at the array inside the
   *  response (e.g. "$.items"); omit if the body IS the array. `paginate` walks
   *  page-numbered endpoints: the engine appends `?<param>=N&<sizeParam>=<size>`
   *  (starting at `startPage`, default 1) and keeps fetching until a page returns
   *  fewer than `size` rows (or `maxPages` is hit — a safety bound). Omit for a
   *  single-shot list. e.g. { "param": "page", "sizeParam": "page_size", "size": 100 } */
  list: z.object({
    method: Method,
    path: z.string().min(1),
    arrayPath: z.string().optional(),
    paginate: z
      .object({
        param: z.string().min(1).max(40),
        size: z.number().int().min(1).max(500),
        sizeParam: z.string().min(1).max(40).optional(),
        startPage: z.number().int().min(0).max(1).default(1),
        maxPages: z.number().int().min(1).max(1000).default(200),
      })
      .optional(),
    /** The list endpoint returns a NESTED tree (children under a `children`
     *  field), not a flat array — the engine flattens it, stamping each node's
     *  parent id (from the nesting) into `__parent_id` so `parentField:
     *  "$.__parent_id"` resolves the hierarchy. For sources whose only listing
     *  is a tree (e.g. Homebox `/entities/tree`). Combine with a `filter` to keep
     *  only the location nodes. */
    tree: z.object({ children: z.string().min(1).max(60).default("children") }).optional(),
  }),
  /** Optional single-item endpoint (fetchOne, for webhook-targeted refetch).
   *  `{externalId}` in the path is substituted. `itemPath` points at the object
   *  inside the response (e.g. "$.item"); omit if the body IS the object. */
  item: z
    .object({ method: Method, path: z.string().min(1), itemPath: z.string().optional() })
    .optional(),
  /** Optional record filter: include a source row only when the extracted value
   *  matches. Lets one endpoint feed several sections — e.g. an inventory API's /printers returns
   *  printers + lasers + CNC (a `category` field); filter each into its own
   *  section/instance. e.g. { "from": "$.category", "equals": "printer" }. */
  filter: z
    .object({
      from: Extract,
      equals: z.string().optional(),
      in: z.array(z.string()).optional(),
      notEquals: z.string().optional(),
    })
    .optional(),
  /** Extract for the source record's stable external id (e.g. "$.id"). */
  idField: Extract,
  /** Extract for the parent's external id (hierarchy), or omit for flat. */
  parentField: Extract.optional(),
  /** The list endpoint returns SUMMARIES — re-fetch each row's full record via
   *  the `item` endpoint before mapping. For sources whose list omits fields the
   *  detail has (Homebox: serial/warranty/manufacturer/custom-fields live only in
   *  GET /entities/{id}). N+1 fetches, concurrency-bounded; requires `item`. */
  hydrate: z.boolean().optional(),
  /** Source-field → target-field mapping. */
  map: z.record(FieldSpec),
  /** Cross-section references: a target field whose value is ANOTHER section's
   *  external id (e.g. a printer's location_id → the locations section). The
   *  engine resolves `from` (the external id in the source) through that
   *  section's id-map to the mirrored Cobblr id. Keep the field OUT of `map` —
   *  references win. e.g. { "location_id": { "section": "locations", "from": "$.location_id" } } */
  references: z.record(z.object({ section: z.string().min(1), from: Extract })).optional(),
  /** Image fields to pull across: a target field → the extract for the source
   *  image URL/path. The engine fetches each (authed, through the bridge), stores
   *  the bytes in core-files, and sets the field to the served file URL. Relative
   *  paths resolve against the source base. A value may TEMPLATE `{$.path}` tokens
   *  from the record, to compose a URL from several fields — e.g. Homebox's
   *  attachment URL: { "image_path": "/api/v1/entities/{$.id}/attachments/{$.imageId}" }.
   *  Plain `$.image_url` still works. */
  images: z.record(Extract).optional(),
});
export type SyncEntityTypeManifest = z.infer<typeof SyncEntityTypeManifest>;

export const SyncSourceManifest = z.object({
  /** Source key — what a connection's connector_id references. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  version: z.string().max(32).optional(),
  /** Optional human hint shown next to the credential field (single-token
   *  sources; ignored when `credentials` describes named fields). */
  credentialLabel: z.string().max(80).optional(),
  baseUrlLabel: z.string().max(80).optional(),
  baseUrlPlaceholder: z.string().max(120).optional(),
  /** Fixed source base URL (e.g. "https://api.ravelry.com"). When set, the source
   *  needs no user-entered base URL — the UI hides the field and the engine uses
   *  this. Omit for sources the user points at their own host (a self-hosted app). */
  baseUrl: z.string().url().max(200).optional(),
  /** Named credential inputs the "Add connection" form renders: key → { label,
   *  secret }. Basic auth needs two (e.g. access_key + personal_key). Omit for the
   *  single-token default (one secret field named per `credentialLabel`). */
  credentials: z
    .record(z.object({ label: z.string().min(1).max(80), secret: z.boolean().default(true) }))
    .optional(),
  /** How stored credentials become a request. Two kinds:
   *   - header: send `header: <prefix?><credential value `from`>` (e.g.
   *     { kind:"header", header:"Authorization", from:"token", prefix:"Bearer " }).
   *   - basic: HTTP Basic — base64(`<userFrom>`:`<passFrom>`) in Authorization
   *     (e.g. { kind:"basic", userFrom:"access_key", passFrom:"personal_key" }). */
  auth: z
    .union([
      z.object({
        kind: z.literal("header"),
        header: z.string().min(1),
        from: z.string().min(1).default("token"),
        prefix: z.string().optional(),
      }),
      z.object({
        kind: z.literal("basic"),
        userFrom: z.string().min(1),
        passFrom: z.string().min(1),
      }),
    ])
    .nullable()
    .optional(),
  /** Bootstrap variables resolved ONCE per fetch, then substituted as `{name}`
   *  in list/item/test paths. Each is a small GET whose result is read at `at`.
   *  Lets a source resolve "who am I" before listing the caller's own data —
   *  e.g. Ravelry: { "username": { "path": "/current_user.json", "at": "$.user.username" } }
   *  then list path "/people/{username}/stash/list.json". */
  resolveVars: z
    .record(z.object({ method: Method, path: z.string().min(1), at: Extract }))
    .optional(),
  /** Cheap connectivity probe (defaults to the first entity type's list path). */
  test: z.object({ method: Method, path: z.string().min(1) }).optional(),
  entityTypes: z.array(SyncEntityTypeManifest).min(1),
  /** Webhook body shape, if the source pushes live changes. `entityField`
   *  identifies which entity type fired; `entityValueMap` maps the source's
   *  value to a manifest entityType key. */
  webhook: z
    .object({
      entityField: Extract,
      entityValueMap: z.record(z.string()).optional(),
      idField: Extract,
      deletedField: Extract.optional(),
      deletedWhen: z.string().optional(),
      /** If the webhook body carries the full record, where it lives (e.g.
       *  "$.record"). When set, the engine applies it directly instead of
       *  re-fetching via the item endpoint. */
      recordPath: Extract.optional(),
    })
    .optional(),
});
export type SyncSourceManifest = z.infer<typeof SyncSourceManifest>;
